/**
 * Persistent agent identity for relay auth (ed25519).
 * Stores keys, pair code, and agent_id in /data for reuse across restarts.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_STORAGE_PATH = process.env.AGENT_IDENTITY_PATH || '/data/royaframe_agent_key.json';
const PAIR_CODE_BYTES = 3;
const KEY_FORMAT = 'ed25519-raw-base64';

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

function base64UrlToBase64(input) {
    if (!input) return input;
    let output = input.replace(/-/g, '+').replace(/_/g, '/');
    const pad = output.length % 4;
    if (pad) {
        output += '='.repeat(4 - pad);
    }
    return output;
}

function exportPublicKey(publicKey) {
    try {
        const jwk = publicKey.export({ format: 'jwk' });
        if (jwk && jwk.kty === 'OKP' && jwk.x) {
            return base64UrlToBase64(jwk.x);
        }
    } catch (_) {
        // Fall through to raw export.
    }

    try {
        const raw = publicKey.export({ format: 'raw' });
        return raw.toString('base64');
    } catch (_) {
        return null;
    }
}

function generateKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const exportedPublic = exportPublicKey(publicKey);
    if (!exportedPublic) {
        throw new Error('Unable to export ed25519 public key');
    }
    return {
        publicKey: exportedPublic,
        privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
    };
}

class AgentIdentity {
    constructor(storagePath = DEFAULT_STORAGE_PATH) {
        this.storagePath = storagePath;
        this.publicKey = null;
        this.privateKey = null;
        this.agentId = null;
        this.pairCode = null;
        this.createdAt = null;
        this.format = KEY_FORMAT;
        this.loaded = false;
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

        if (!data || !data.private_key) {
            const keys = generateKeyPair();
            this.publicKey = keys.publicKey;
            this.privateKey = keys.privateKey;
            this.createdAt = new Date().toISOString();
            this.pairCode = generatePairCode();
            this.agentId = null;
            this.save();
        } else {
            try {
                const privateKey = crypto.createPrivateKey({
                    key: Buffer.from(data.private_key, 'base64'),
                    format: 'der',
                    type: 'pkcs8'
                });
                const publicKeyObj = crypto.createPublicKey(privateKey);
                const exportedPublic = exportPublicKey(publicKeyObj);
                if (!exportedPublic) {
                    throw new Error('Unsupported public key export');
                }

                this.privateKey = data.private_key;
                this.publicKey = exportedPublic;
                this.agentId = data.agent_id || null;
                this.pairCode = normalizePairCode(data.pair_code) || generatePairCode();
                this.createdAt = data.created_at || new Date().toISOString();

                const pairCodeValid = normalizePairCode(data.pair_code);
                const formatNeedsUpdate = data.format !== KEY_FORMAT || data.public_key !== this.publicKey || !pairCodeValid;
                if (formatNeedsUpdate) {
                    this.save();
                }
            } catch (err) {
                console.error('[identity] Failed to load existing keypair, regenerating:', err.message);
                const keys = generateKeyPair();
                this.publicKey = keys.publicKey;
                this.privateKey = keys.privateKey;
                this.createdAt = new Date().toISOString();
                this.pairCode = generatePairCode();
                this.agentId = null;
                this.save();
            }
        }

        this.loaded = true;
    }

    save() {
        ensureDirExists(this.storagePath);
        const payload = {
            format: this.format,
            created_at: this.createdAt,
            public_key: this.publicKey,
            private_key: this.privateKey,
            agent_id: this.agentId,
            pair_code: this.pairCode
        };
        fs.writeFileSync(this.storagePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    }

    getPublicKey() {
        this.load();
        return this.publicKey;
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

    sign(nonce) {
        this.load();
        const data = Buffer.from(String(nonce), 'utf8');
        const privateKey = crypto.createPrivateKey({
            key: Buffer.from(this.privateKey, 'base64'),
            format: 'der',
            type: 'pkcs8'
        });
        const signature = crypto.sign(null, data, privateKey);
        return signature.toString('base64');
    }
}

const identity = new AgentIdentity(DEFAULT_STORAGE_PATH);
identity.load();

module.exports = identity;
