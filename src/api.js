// The restored Figma UI uses the local PostgreSQL API by default.
// Set VITE_API_URL when pointing the same UI at another compatible API.
const API_URL = (import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');

export const apiConfig = {
  url: API_URL,
  configured: Boolean(API_URL),
};

export async function apiRequest(action, payload = {}) {
  if (!API_URL) throw new Error('ยังไม่ได้ตั้งค่า VITE_API_URL');
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, payload }),
      signal: controller.signal,
    });
    let body;
    try { body = await response.json(); } catch (error) { throw new Error('API ส่งข้อมูลกลับมาไม่ถูกต้อง'); }
    if (!response.ok || !body?.ok) throw new Error(body?.error || `API ตอบกลับด้วยสถานะ ${response.status}`);
    return body.data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('API ใช้เวลานานเกินไป กรุณาลองใหม่');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export function demoQueue() {
  const now = new Date().toISOString();
  return {
    date: now.slice(0, 10),
    tickets: [
      { id: 'demo-1', ticketCode: 'Q001', category: 'general', categoryLabel: 'ผู้ป่วยทั่วไป', priority: 10, status: 'waiting', sequenceNo: 1, issuedAt: now, arrivedAt: now, currentPoint: 1 },
      { id: 'demo-2', ticketCode: 'Q002', category: 'general', categoryLabel: 'ผู้ป่วยทั่วไป', priority: 10, status: 'waiting', sequenceNo: 2, issuedAt: now, arrivedAt: now, currentPoint: 1 },
      { id: 'demo-3', ticketCode: 'Q003', category: 'emergency', categoryLabel: 'ผู้ป่วยฉุกเฉิน', priority: 100, status: 'waiting', sequenceNo: 3, issuedAt: now, arrivedAt: now, currentPoint: 1 },
    ],
    current: null,
    waiting: [],
    skipped: [],
  };
}
