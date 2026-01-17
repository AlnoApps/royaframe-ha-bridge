/**
 * Persistent agent identity for relay auth (ed25519).
 * Stores keys, pair code, and agent_id in /data for reuse across restarts.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_STORAGE_PATH = process.env.AGENT_IDENTITY_PATH || '/data/royaframe_agent_key.json';
const PAIR_CODE_BYTES = 3;

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

function generateKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
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
        this.format = 'ed25519-der-base64';
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

        if (!data || !data.public_key || !data.private_key) {
            const keys = generateKeyPair();
            this.publicKey = keys.publicKey;
            this.privateKey = keys.privateKey;
            this.createdAt = new Date().toISOString();
            this.pairCode = generatePairCode();
            this.agentId = null;
            this.save();
        } else {
            this.publicKey = data.public_key;
            this.privateKey = data.private_key;
            this.agentId = data.agent_id || null;
            this.pairCode = normalizePairCode(data.pair_code) || generatePairCode();
            this.createdAt = data.created_at || new Date().toISOString();
            if (!normalizePairCode(data.pair_code)) {
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
