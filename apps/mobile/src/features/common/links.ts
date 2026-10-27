// D-05 (2026-10-27): public links live on studify.vendua.com.br. EXPO_PUBLIC_BASE_URL can point a
// dev/preview build elsewhere; the custom scheme stays for internal routes (mobile-app.md §2.3).
export const PUBLIC_BASE_URL = (process.env.EXPO_PUBLIC_BASE_URL || 'https://studify.vendua.com.br').replace(/\/$/, '');

/** Turma invite (SOC-01.3): App Link, so WhatsApp linkifies it. */
export const classInviteLink = (code: string) => `${PUBLIC_BASE_URL}/c/${code}`;

/** Live battle join (SOC-03.3), encoded in the room QR. */
export const battleJoinLink = (pin: string) => `${PUBLIC_BASE_URL}/b/${pin}`;

/** Public pages on the site: privacidade, ajuda, termos… */
export const sitePage = (path: string) => `${PUBLIC_BASE_URL}/${path.replace(/^\//, '')}`;
