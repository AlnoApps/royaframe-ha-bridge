/**
 * Persistent agent identity for relay auth (ed25519).
 * Stores keys, pair code, and agent_id in /data for reuse across restarts.
 *
 * Key format: JWK with x (public) and d (private seed) as base64url strings.
 * Public key sent to relay: base64url of 32-byte Ed25519 public key (JWK x field).
 * Signature: base64url of 64-byte Ed25519 signature.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_STORAGE_PATH = process.env.AGENT_IDENTITY_PATH || '/data/royaframe_agent.json';
const PAIR_CODE_BYTES = 3;
const KEY_FORMAT = 'ed25519-jwk-v2';

function normalizePairCode(input) {
    if (!input) return null;
    const normalized = String(input).trim().toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(normalized)) return null;
    return normalized;
}

function ensureDirExists(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function generatePairCode() {
    return crypto.randomBytes(PAIR_CODE_BYTES).toString('hex').toUpperCase();
}

/**
 * Convert base64url to standard base64.
 */
function base64UrlToBase64(input) {
    if (!input) return input;
    let output = input.replace(/-/g, '+').replace(/_/g, '/');
    const pad = output.length % 4;
    if (pad) {
        output += '='.repeat(4 - pad);
    }
    return output;
}

/**
 * Convert standard base64 to base64url (no padding).
 */
function base64ToBase64Url(input) {
    if (!input) return input;
    return input.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode a base64 or base64url string to Buffer.
 * Handles both formats and optional padding.
 */
function decodeBase64Any(input) {
    if (!input || typeof input !== 'string') {
        throw new Error('Invalid base64 input');
    }
    // Convert to standard base64 for decoding
    const base64 = base64UrlToBase64(input);
    return Buffer.from(base64, 'base64');
}

/**
 * Generate Ed25519 keypair and export JWK fields.
 * Returns { public_key_x, private_key_d } both as base64url strings.
 */
function generateKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

    const publicJwk = publicKey.export({ format: 'jwk' });
    const privateJwk = privateKey.export({ format: 'jwk' });

    if (!publicJwk || publicJwk.kty !== 'OKP' || !publicJwk.x) {
        throw new Error('Failed to export public key as JWK');
    }
    if (!privateJwk || privateJwk.kty !== 'OKP' || !privateJwk.d) {
        throw new Error('Failed to export private key as JWK');
    }

    // JWK x and d are already base64url encoded
    return {
        public_key_x: publicJwk.x,
        private_key_d: privateJwk.d
    };
}

/**
 * Reconstruct KeyObject from JWK fields.
 */
function createPrivateKeyFromJwk(publicKeyX, privateKeyD) {
    const jwk = {
        kty: 'OKP',
        crv: 'Ed25519',
        x: publicKeyX,
        d: privateKeyD
    };
    return crypto.createPrivateKey({ format: 'jwk', key: jwk });
}

function createPublicKeyFromJwk(publicKeyX) {
    const jwk = {
        kty: 'OKP',
        crv: 'Ed25519',
        x: publicKeyX
    };
    return crypto.createPublicKey({ format: 'jwk', key: jwk });
}

/**
 * Migrate from old PKCS8 DER format to new JWK format.
 */
function migrateFromOldFormat(data) {
    if (!data.private_key) return null;

    try {
        // Old format stored private key as PKCS8 DER base64
        const privateKey = crypto.createPrivateKey({
            key: Buffer.from(data.private_key, 'base64'),
            format: 'der',
            type: 'pkcs8'
        });

        const privateJwk = privateKey.export({ format: 'jwk' });
        const publicKey = crypto.createPublicKey(privateKey);
        const publicJwk = publicKey.export({ format: 'jwk' });

        if (!publicJwk.x || !privateJwk.d) {
            throw new Error('Migration failed: invalid JWK export');
        }

        console.log('[identity] Migrated from old key format to JWK');
        return {
            public_key_x: publicJwk.x,
            private_key_d: privateJwk.d
        };
    } catch (err) {
        console.error('[identity] Migration from old format failed:', err.message);
        return null;
    }
}

class AgentIdentity {
    constructor(storagePath = DEFAULT_STORAGE_PATH) {
        this.storagePath = storagePath;
        this.publicKeyX = null;   // base64url, 32 bytes decoded
        this.privateKeyD = null;  // base64url, 32 bytes decoded (seed)
        this.agentId = null;
        this.pairCode = null;
        this.createdAt = null;
        this.format = KEY_FORMAT;
        this.loaded = false;

        // Cached KeyObjects
        this._privateKeyObj = null;
        this._publicKeyObj = null;
    }

    load() {
        if (this.loaded) return;

        let data = null;
        if (fs.existsSync(this.storagePath)) {
            try {
                data = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'));
            } catch (err) {
                console.error('[identity] Failed to parse identity file, regenerating:', err.message);
            }
        }

        // Also check old storage path for migration
        const oldPath = '/data/royaframe_agent_key.json';
        if (!data && fs.existsSync(oldPath)) {
            try {
                data = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
                console.log('[identity] Found identity at old path, will migrate');
            } catch (err) {
                console.error('[identity] Failed to parse old identity file:', err.message);
            }
        }

        let keys = null;
        let needsSave = false;

        if (data) {
            // Check if it's new JWK format
            if (data.format === KEY_FORMAT && data.public_key_x && data.private_key_d) {
                keys = {
                    public_key_x: data.public_key_x,
                    private_key_d: data.private_key_d
                };
                // Validate the keys work
                try {
                    const testKey = createPrivateKeyFromJwk(keys.public_key_x, keys.private_key_d);
                    if (!testKey) throw new Error('Invalid key');
                } catch (err) {
                    console.error('[identity] Stored JWK keys invalid, regenerating:', err.message);
                    keys = null;
                }
            } else if (data.private_key) {
                // Old format, migrate
                keys = migrateFromOldFormat(data);
                needsSave = true;
            }
        }

        if (!keys) {
            // Generate new keypair
            console.log('[identity] Generating new Ed25519 keypair');
            keys = generateKeyPair();
            this.createdAt = new Date().toISOString();
            this.pairCode = generatePairCode();
            this.agentId = null;
            needsSave = true;
        } else {
            this.agentId = data?.agent_id || null;
            this.pairCode = normalizePairCode(data?.pair_code) || generatePairCode();
            this.createdAt = data?.created_at || new Date().toISOString();

            if (!normalizePairCode(data?.pair_code)) {
                needsSave = true;
            }
        }

        this.publicKeyX = keys.public_key_x;
        this.privateKeyD = keys.private_key_d;

        // Pre-create KeyObjects
        try {
            this._privateKeyObj = createPrivateKeyFromJwk(this.publicKeyX, this.privateKeyD);
            this._publicKeyObj = createPublicKeyFromJwk(this.publicKeyX);
        } catch (err) {
            console.error('[identity] Failed to create KeyObjects:', err.message);
            throw err;
        }

        // Validate key sizes
        const pubBytes = decodeBase64Any(this.publicKeyX);
        const privBytes = decodeBase64Any(this.privateKeyD);
        console.log(`[identity] Key loaded: public_key_bytes=${pubBytes.length}, private_seed_bytes=${privBytes.length}`);

        if (pubBytes.length !== 32) {
            throw new Error(`Invalid public key size: expected 32, got ${pubBytes.length}`);
        }
        if (privBytes.length !== 32) {
            throw new Error(`Invalid private seed size: expected 32, got ${privBytes.length}`);
        }

        if (needsSave) {
            this.save();
        }

        this.loaded = true;
        console.log(`[identity] Agent identity ready, pair_code=${this.pairCode}, agent_id=${this.agentId || '(none)'}`);
    }

    save() {
        ensureDirExists(this.storagePath);
        const payload = {
            format: this.format,
            created_at: this.createdAt,
            public_key_x: this.publicKeyX,
            private_key_d: this.privateKeyD,
            agent_id: this.agentId,
            pair_code: this.pairCode
        };
        fs.writeFileSync(this.storagePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    }

    /**
     * Get the public key as base64url string (JWK x field).
     * This is what gets sent to the relay server.
     */
    getPublicKey() {
        this.load();
        return this.publicKeyX;
    }

    /**
     * Get debug info about key sizes (without exposing actual keys).
     */
    getKeyInfo() {
        this.load();
        const pubBytes = decodeBase64Any(this.publicKeyX);
        return {
            public_key_bytes: pubBytes.length,
            public_key_string_length: this.publicKeyX.length
        };
    }

    getAgentId() {
        this.load();
        return this.agentId;
    }

    setAgentId(agentId) {
        this.load();
        if (!agentId || agentId === this.agentId) return;
        this.agentId = agentId;
        this.save();
    }

    getPairCode() {
        this.load();
        return this.pairCode;
    }

    setPairCode(pairCode) {
        this.load();
        const normalized = normalizePairCode(pairCode);
        if (!normalized) return false;
        if (normalized === this.pairCode) return true;
        this.pairCode = normalized;
        this.save();
        return true;
    }

    regeneratePairCode() {
        this.load();
        this.pairCode = generatePairCode();
        this.save();
        return this.pairCode;
    }

    /**
     * Sign a nonce (base64 or base64url encoded) with the private key.
     * Returns base64url encoded signature (64 bytes decoded).
     */
    sign(nonceB64) {
        this.load();

        // Decode the nonce from base64/base64url to raw bytes
        let nonceBytes;
        try {
            nonceBytes = decodeBase64Any(nonceB64);
        } catch (err) {
            console.error('[identity] Failed to decode nonce:', err.message);
            throw new Error('Invalid nonce encoding');
        }

        console.log(`[identity] Signing nonce: input_length=${nonceB64.length}, decoded_bytes=${nonceBytes.length}`);

        // Sign the raw nonce bytes with Ed25519
        const signature = crypto.sign(null, nonceBytes, this._privateKeyObj);

        // Convert signature to base64url
        const signatureB64url = base64ToBase64Url(signature.toString('base64'));

        console.log(`[identity] Signature: bytes=${signature.length}, base64url_length=${signatureB64url.length}`);

        if (signature.length !== 64) {
            console.error(`[identity] WARNING: Unexpected signature size: ${signature.length}, expected 64`);
        }

        return signatureB64url;
    }

    /**
     * Verify a signature (for testing).
     */
    verify(nonceB64, signatureB64url) {
        this.load();
        const nonceBytes = decodeBase64Any(nonceB64);
        const sigBytes = decodeBase64Any(signatureB64url);
        return crypto.verify(null, nonceBytes, this._publicKeyObj, sigBytes);
    }
}

const identity = new AgentIdentity(DEFAULT_STORAGE_PATH);
identity.load();

module.exports = identity;
