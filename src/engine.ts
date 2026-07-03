import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { useSupabaseAuthState } from './supabase-auth';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const VERCEL_WEBHOOK_URL = process.env.VERCEL_WEBHOOK_URL || 'https://chatbot-project-inky-nine.vercel.app/api/public/qr/webhook';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const logger = pino({ level: 'silent' });

export const sessions = new Map<string, any>();
export const qrCodes = new Map<string, string>(); // sessionId -> base64 qr code

export async function startSession(sessionId: string) {
    const { state, saveCreds } = await useSupabaseAuthState(supabase, sessionId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: state,
        generateHighQualityLinkPreview: false,
        syncFullHistory: false
    });

    sessions.set(sessionId, sock);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            try {
                const QRCode = require('qrcode');
                const qrUrl = await QRCode.toDataURL(qr);
                qrCodes.set(sessionId, qrUrl);
                // Update status in supabase
                await supabase.from('qr_integrations').update({ status: 'qr_ready', qr_code: qrUrl }).eq('session_name', sessionId);
            } catch(e) {
                console.error('Failed to generate QR data URL', e);
            }
        }

        if (connection === 'close') {
            qrCodes.delete(sessionId);
            const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`Connection closed for ${sessionId}. Reconnecting: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                setTimeout(() => startSession(sessionId), 5000);
            } else {
                sessions.delete(sessionId);
                await supabase.from('qr_integrations').update({ status: 'disconnected', qr_code: null }).eq('session_name', sessionId);
                await supabase.from('baileys_auth').delete().eq('session_name', sessionId);
            }
        } else if (connection === 'open') {
            console.log(`Connected to WhatsApp: ${sessionId}`);
            qrCodes.delete(sessionId);
            
            let phone = 'Desconhecido';
            if (sock.user?.id) {
                // sock.user.id looks like "5511999999999:1@s.whatsapp.net"
                phone = sock.user.id.split(':')[0].split('@')[0];
                // format phone as +55 11... optional, let's just add a + 
                phone = '+' + phone;
            }

            await supabase.from('qr_integrations').update({ 
                status: 'connected', 
                qr_code: null,
                display_name: phone
            }).eq('session_name', sessionId);
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify' && m.type !== 'append') return;
        
        for (const msg of m.messages) {
            console.log('Received message from Baileys:', JSON.stringify({
              from: msg.key.remoteJid,
              fromMe: msg.key.fromMe,
              type: msg.message ? Object.keys(msg.message) : null
            }));

            if (!msg.message) continue;

            const from = msg.key.remoteJid;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

            console.log(`Processing message from ${from}: ${text} (fromMe: ${msg.key.fromMe})`);

            if (text && from && !from.includes('@g.us')) { // Ignore groups
                try {
                    // Send message to Vercel webhook
                    console.log(`Forwarding to Vercel: ${VERCEL_WEBHOOK_URL}`);
                    const res = await axios.post(VERCEL_WEBHOOK_URL, {
                        sessionId,
                        from,
                        text,
                        fromMe: msg.key.fromMe
                    });

                    console.log(`Vercel responded with status ${res.status}`);
                    if (res.data && res.data.reply) {
                        console.log(`Sending reply to ${from}: ${res.data.reply.substring(0, 50)}...`);
                        await sock.sendMessage(from, { text: res.data.reply });
                    } else {
                        console.log(`No reply content in Vercel response.`);
                    }
                } catch (error: any) {
                    console.error('Error forwarding message to Vercel:', error.message);
                    if (error.response) {
                        console.error('Vercel response data:', error.response.data);
                    }
                }
            } else {
                console.log('Ignored message (no text, or is group)');
            }
        }
    });

    return sock;
}

export function stopSession(sessionId: string) {
    const sock = sessions.get(sessionId);
    if (sock) {
        sock.logout();
        sessions.delete(sessionId);
        qrCodes.delete(sessionId);
    }
}
