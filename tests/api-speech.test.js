import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest, demoQueue } from '../src/api.js';
import { speakQueue } from '../src/speech.js';

describe('queue API', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns API data and clears its timeout', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, data: { tickets: [] } }) });
    await expect(apiRequest('getQueue')).resolves.toEqual({ tickets: [] });
    expect(fetch).toHaveBeenCalledWith('/api', expect.objectContaining({ method: 'POST' }));
  });

  it('reports invalid and failed responses', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } });
    await expect(apiRequest('getQueue')).rejects.toThrow('ระบบส่งข้อมูลกลับมาไม่ถูกต้อง');
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ ok: false, error: 'ฐานข้อมูลไม่พร้อม' }) });
    await expect(apiRequest('getQueue')).rejects.toThrow('ฐานข้อมูลไม่พร้อม');
  });

  it('reports an aborted request as a timeout', async () => {
    global.fetch = vi.fn((_, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const request = apiRequest('getQueue');
    const rejection = expect(request).rejects.toThrow('การเชื่อมต่อใช้เวลานานเกินไป');
    await vi.advanceTimersByTimeAsync(20000);
    await rejection;
  });

  it('creates stable demonstration queue data', () => {
    const result = demoQueue();
    expect(result.tickets.map(ticket => ticket.ticketCode)).toEqual(['Q001', 'Q002', 'Q003']);
    expect(result.tickets[2].category).toBe('emergency');
  });
});

describe('queue speech', () => {
  it('announces Thai queue text with a Thai voice', () => {
    class Utterance { constructor(text) { this.text = text; } }
    const thaiVoice = { lang: 'th-TH' };
    window.SpeechSynthesisUtterance = Utterance;
    window.speechSynthesis = { getVoices: () => [{ lang: 'en-US' }, thaiVoice], cancel: vi.fn(), speak: vi.fn() };
    expect(speakQueue({ ticketCode: 'Q012', currentPoint: 4 })).toBe(true);
    const spoken = window.speechSynthesis.speak.mock.calls[0][0];
    expect(spoken.text).toContain('คิว');
    expect(spoken.text).toContain('4');
    expect(spoken.voice).toBe(thaiVoice);
    expect(spoken.rate).toBe(0.55);
  });

  it('does not announce incomplete data or an unsupported browser', () => {
    window.speechSynthesis = { getVoices: () => [], cancel: vi.fn(), speak: vi.fn() };
    expect(speakQueue({})).toBe(false);
    delete window.speechSynthesis;
    expect(speakQueue({ ticketCode: 'Q001' })).toBe(false);
  });
});
