import express from 'express';
import cors from 'cors';
import { startSession, stopSession, qrCodes, sessions } from './engine';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import QRCode from 'qrcode';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

app.use(cors());
app.use(express.json());

// Auto-start active sessions on boot
async function initSessions() {
    console.log('Initializing sessions from database...');
    const { data: activeSessions } = await supabase.from('qr_integrations').select('session_name').eq('status', 'connected');
    if (activeSessions) {
        for (const s of activeSessions) {
            console.log(`Starting session ${s.session_name}`);
            startSession(s.session_name);
        }
    }
}
initSessions();

// Create or connect a session
app.post('/session/start', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    if (sessions.has(sessionId)) {
        return res.json({ message: 'Session already active', status: 'connected' });
    }

    await startSession(sessionId);
    res.json({ message: 'Starting session, wait for QR code' });
});

// Get QR Code
app.get('/session/qr/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const qrText = qrCodes.get(sessionId);

    if (sessions.has(sessionId) && !qrText) {
        return res.json({ status: 'connected', qrUrl: null });
    }

    if (qrText) {
        try {
            const qrUrl = await QRCode.toDataURL(qrText);
            return res.json({ status: 'qr_ready', qrUrl });
        } catch (err) {
            return res.status(500).json({ error: 'Failed to generate QR Code image' });
        }
    }

    res.json({ status: 'disconnected', qrUrl: null });
});

// Logout and stop
app.post('/session/logout', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    stopSession(sessionId);
    res.json({ message: 'Logged out' });
});

app.listen(port, () => {
    console.log(`WhatsApp Engine running on port ${port}`);
});
