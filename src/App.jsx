import React, { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { apiConfig, apiRequest, demoQueue } from './api.js';
import generalQueueBg from './assets/queue-general-bg.png';
import emergencyQueueBg from './assets/queue-emergency-bg.png';
import adminPerson from './assets/admin-person.svg';
import adminAccount from './assets/admin-account.svg';
import adminDashboard from './assets/admin-dashboard.svg';
import queueAlarm from './assets/queue-alarm.svg';
import { speakQueue } from './speech.js';
import { useDashboardMetrics } from './hooks/useDashboardMetrics.js';
import { useQueueData } from './hooks/useQueueData.js';
import { buildDashboardFallback, buildDashboardViewModel, formatDashboardUpdatedAt } from './dashboardMetrics.js';
import { downloadCsvReport, downloadExcelReport, printReport } from './reportExport.js';

const CATEGORY = {
  general: { label: 'ผู้ป่วยทั่วไป', description: 'รับบริการตามลำดับคิวปกติ', color: 'blue', icon: '▣' },
  emergency: { label: 'อุบัติเหตุ', description: 'เจ้าหน้าที่สามารถจัดลำดับก่อนเมื่อจำเป็น', color: 'red', icon: '✚' },
};

// Demo-only staff accounts. They are intentionally separate from an admin role.
const MOCK_STAFF_ACCOUNTS = {
  point1: { password: 'test1234', point: 1, name: 'เจ้าหน้าที่จุดบริการ 1' },
  point3: { password: 'test1234', point: 3, name: 'เจ้าหน้าที่จุดบริการ 3' },
  point4: { password: 'test1234', point: 4, name: 'เจ้าหน้าที่จุดบริการ 4' },
  point6: { password: 'test1234', point: 6, name: 'เจ้าหน้าที่จุดบริการ 6' },
  point7: { password: 'test1234', point: 7, name: 'เจ้าหน้าที่จุดบริการ 7' },
};

const KU_ALLLOGIN_MOCK_PATH = '/auth/ku-alllogin';
const KU_ALLLOGIN_URL = String(import.meta.env.VITE_KU_ALLLOGIN_URL || '').trim();

function navigate(path) {
  const nextHash = `#${path}`;
  if (window.location.hash === nextHash) {
    // A guarded deep link (for example /#/operator) may already have this
    // hash while showing Login. Notify the hash-route hook so it re-checks
    // the newly established session immediately after sign-in.
    window.dispatchEvent(new Event('hashchange'));
    return;
  }
  window.location.hash = path;
}

function openKuAllLogin() {
  if (KU_ALLLOGIN_URL) {
    window.location.assign(KU_ALLLOGIN_URL);
    return;
  }
  navigate(KU_ALLLOGIN_MOCK_PATH);
}

function useHashRoute() {
  const readRoute = () => {
    const currentRoute = window.location.hash.replace(/^#/, '') || '/';
    if (currentRoute === '/report') {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/dashboard`);
      return '/dashboard';
    }
    return currentRoute;
  };
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const update = () => setRoute(readRoute());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}

function Shell({ children, title = '', role = '', simple = false }) {
  return <div className={`app-shell ${simple ? 'simple-shell' : ''}`}>
    {!simple && <header className="topbar">
      <button className="brand" onClick={() => navigate('/')}>ระบบรันคิว</button>
      <span className="topbar-title">{title}</span>
      <span className="role-chip">{role}</span>
    </header>}
    {children}
    {!simple && <footer className="footer"><strong>ระบบรันคิว</strong><span>© 2024 ระบบจัดการคิว สงวนลิขสิทธิ์</span><nav><button onClick={() => navigate('/kiosk')}>บริการ</button><button onClick={() => navigate('/confirm')}>บัตรคิวของฉัน</button><button>ประวัติ</button></nav></footer>}
  </div>;
}

function StatusBanner({ error }) { return error ? <div className="status-banner">{error}</div> : null; }

function DisplayTicket({ ticket, empty = false }) {
  if (empty) return <article className="display-ticket empty-ticket"><div className="display-number" /><div className="display-service" /></article>;
  const category = CATEGORY[ticket.category] || CATEGORY.general;
  return <article className={`display-ticket ${ticket.status === 'called' ? 'is-called' : ''}`}>
    <div className="display-number">{ticket.ticketCode}</div>
    <div className="display-service"><strong>{category.label}</strong><span>จุดบริการ {ticket.currentPoint || 1}</span></div>
  </article>;
}

function QueueDisplay({ queueData }) {
  const source = queueData || demoQueue();
  const tickets = source.tickets || [];
  const active = tickets.filter(ticket => ['waiting', 'called', 'serving', 'skipped'].includes(ticket.status));
  const called = active
    .filter(ticket => ['called', 'serving'].includes(ticket.status))
    .sort((a, b) => new Date(b.calledAt || b.updatedAt || 0) - new Date(a.calledAt || a.updatedAt || 0));
  const demoCurrent = {
    general: { ticketCode: 'Q067', category: 'general' },
    emergency: { ticketCode: 'Q071', category: 'emergency' },
  };
  const latestAtPoint = (servicePoint, fallbackCategory) => called.find(ticket => Number(ticket.currentPoint) === servicePoint)
    || (apiConfig.configured ? { ticketCode: '—', category: fallbackCategory, currentPoint: servicePoint } : { ...demoCurrent[fallbackCategory], currentPoint: servicePoint });
  const point4Current = latestAtPoint(4, 'general');
  const point7Current = latestAtPoint(7, 'emergency');
  const upcoming = tickets
    .filter(ticket => ticket.status === 'waiting' && [4, 7].includes(Number(ticket.currentPoint)))
    .sort((a, b) => new Date(a.arrivedAt || a.issuedAt).getTime() - new Date(b.arrivedAt || b.issuedAt).getTime() || (Number(a.sequenceNo) || 0) - (Number(b.sequenceNo) || 0));
  const history = (source.history || (apiConfig.configured
    ? called.filter(ticket => ticket !== point4Current && ticket !== point7Current)
    : [{ id: 'demo-history-1', ticketCode: 'Q068', counter: 3 }, { id: 'demo-history-2', ticketCode: 'Q069', counter: 4 }, { id: 'demo-history-3', ticketCode: 'Q070', counter: 5 }]))
    .slice(0, 10);
  const displayTime = new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  return <div className="queue-display-shell">
    <header className="queue-display-header">
      <div>
        <h1>ประกาศเรียกหมายเลขคิว</h1>
        <p>สถานพยาบาล มหาวิทยาลัยเกษตรศาสตร์ วิทยาเขตกำแพงแสน</p>
      </div>
      <button type="button" className="logout-button display-home-button" onClick={() => navigate('/')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8" /></svg>กลับหน้าหลัก</button>
    </header>
    <main className="queue-display-main">
      <section className="queue-display-current-grid">
        {[point4Current, point7Current].map(ticket => <article className="queue-display-current" key={ticket.currentPoint}>
          <div className="queue-display-number">{ticket.ticketCode}</div>
          <div className="queue-display-current-copy"><strong>จุดบริการ {ticket.currentPoint}</strong><small className="queue-display-category">ประเภท: {ticket.currentPoint === 4 ? 'ผู้ป่วยทั่วไป' : 'อุบัติเหตุ'}</small><span>กำลังเรียก</span></div>
        </article>)}
      </section>
      <aside className="queue-display-history">
        <h2>คิวที่เรียกไปแล้ว</h2>
        <div className="queue-display-history-list">
          {history.map((ticket, index) => <div className="queue-display-history-row" key={ticket.id || `${ticket.ticketCode}-${index}`}><strong>{ticket.ticketCode}</strong><span>จุดบริการ {ticket.currentPoint || ticket.counter || (index + 3)}</span></div>)}
          {!history.length && <div className="queue-display-history-empty"><span className="display-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="3" width="14" height="18" rx="3" /><path d="M9 8h6M9 12h6M9 16h3" /></svg></span><span>ยังไม่มีประวัติการเรียกคิว</span></div>}
        </div>
        <div className="queue-display-clock"><img src={queueAlarm} alt="" />{displayTime} น.</div>
      </aside>
      <section className="queue-display-upcoming-grid">
        {[4, 7].map(point => {
          const pointQueue = upcoming.filter(ticket => Number(ticket.currentPoint) === point);
          return <section className="queue-display-upcoming" key={point}>
            <header><h2>คิวรอจุดบริการ {point}<span className="queue-count">{pointQueue.length} คิว</span></h2><strong>สถานะ</strong></header>
            <div className="queue-display-upcoming-list">
              {pointQueue.map(ticket => <div className="queue-display-upcoming-row" key={ticket.id}>
                <strong>{ticket.ticketCode}</strong><em>รอเรียก</em>
              </div>)}
              {!pointQueue.length && <div className="queue-display-history-empty"><span className="display-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="3" width="14" height="18" rx="3" /><path d="M9 8h6M9 12h6M9 16h3" /></svg></span><span>ไม่มีคิวรอเรียก</span></div>}
            </div>
          </section>;
        })}
      </section>
    </main>
  </div>;
}

function ticketTime(ticket) {
  const issuedAt = new Date(ticket?.issuedAt || ticket?.createdAt || '');
  if (Number.isNaN(issuedAt.getTime())) return 'ไม่ระบุเวลา';
  return `${new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false }).format(issuedAt)} น.`;
}

function Kiosk({ onCreate, latestTicket }) {
  const [category, setCategory] = useState('');
  const [phone, setPhone] = useState('');
  const [success, setSuccess] = useState(null);
  const [lastIssuedTicket, setLastIssuedTicket] = useState(latestTicket || null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (latestTicket) setLastIssuedTicket(latestTicket);
  }, [latestTicket]);
  async function submit() {
    if (!category) return;
    setBusy(true);
    try {
      const ticket = await onCreate(category, phone);
      setSuccess(ticket);
      setLastIssuedTicket(ticket);
      setCategory('');
      setPhone('');
    }
    catch (err) { window.alert(err.message); }
    finally { setBusy(false); }
  }
  function printTicket() {
    try {
      window.print();
    } finally {
      setSuccess(null);
    }
  }
  return <Shell simple><div className="kiosk-screen">
    <header className="kiosk-topbar"><span>คลินิกมหาวิทยาลัยเกษตรศาสตร์ วิทยาเขตกำแพงแสน</span><button type="button" className="logout-button" onClick={() => navigate('/')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 5-7 7 7 7M5 12h14" /></svg>กลับหน้าหลัก</button></header>
    <main className="kiosk-content"><h1>รับบัตรคิว</h1><p className="kiosk-intro">เลือกประเภทผู้รับบริการ แล้วกดยืนยันเพื่อรับหมายเลขคิว</p><section className="kiosk-panel">
      <div className="kiosk-panel-head"><strong>เลือกบริการที่ต้องการ</strong><span>กรุณาเลือก 1 ประเภทบริการ</span></div>
      <div className="kiosk-options">{Object.entries(CATEGORY).map(([key, item]) => <button key={key} className={`kiosk-option ${category === key ? 'selected' : ''}`} aria-pressed={category === key} onClick={() => setCategory(key)}><span className="kiosk-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{key === 'general' ? <><rect x="5" y="4" width="14" height="17" rx="3" /><path d="M9 4V2h6v2M9 10h6M9 14h6M9 18h3" /></> : <path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6Z" />}</svg></span><span className="kiosk-option-copy"><strong>{item.label}</strong><small>{key === 'general' ? 'เข้ารับบริการตามลำดับคิว' : 'เข้ารับบริการด้านอุบัติเหตุ'}</small></span>{category === key && <span className="kiosk-selection-check" aria-hidden="true">✓</span>}</button>)}</div>
      <button className="kiosk-confirm" disabled={!category || busy} onClick={submit}>{busy ? 'กำลังออกคิว...' : 'ยืนยันรับบัตรคิว'}</button>
      <p className="kiosk-note">คิวฉุกเฉินสามารถถูกจัดลำดับก่อนโดยเจ้าหน้าที่ และคิวที่ถูกข้ามจะถูกเรียกซ้ำภายหลัง</p>
    </section>
    <section className="kiosk-latest-ticket" aria-live="polite">
      <header><strong>ออกบัตรคิวล่าสุด</strong><span>ข้อมูลการออกบัตรคิววันนี้</span></header>
      {lastIssuedTicket ? <div className="kiosk-latest-ticket-body">
        <div className="kiosk-latest-ticket-number"><small>หมายเลขคิว</small><b>{lastIssuedTicket.ticketCode}</b></div>
        <div className="kiosk-latest-ticket-meta"><span>ประเภท</span><strong>{CATEGORY[lastIssuedTicket.category]?.label || 'ผู้ป่วยทั่วไป'}</strong><span>เวลาออกบัตร {ticketTime(lastIssuedTicket)}</span></div>
      </div> : <p className="kiosk-latest-ticket-empty">ยังไม่มีการออกบัตรคิววันนี้</p>}
    </section></main>
    {success && <div className="kiosk-ticket-modal-backdrop">
      <section className="kiosk-ticket-modal" role="dialog" aria-modal="true" aria-labelledby="kiosk-ticket-modal-title">
        <span className="kiosk-ticket-modal-check" aria-hidden="true">✓</span>
        <h2 id="kiosk-ticket-modal-title">ออกบัตรคิวสำเร็จ</h2>
        <p>กรุณาตรวจสอบหมายเลขก่อนเลือกพิมพ์บัตรคิว</p>
        <div className="kiosk-ticket-modal-summary"><small>หมายเลขคิว</small><b>{success.ticketCode}</b><span>ประเภท: {CATEGORY[success.category]?.label || 'ผู้ป่วยทั่วไป'}</span><span>เวลาออกบัตร: {ticketTime(success)}</span></div>
        <div className="kiosk-ticket-modal-actions">
          <button className="print-ticket-button primary" type="button" onClick={printTicket}>พิมพ์บัตรคิว</button>
          <button className="print-ticket-cancel" type="button" onClick={() => setSuccess(null)}>ไม่พิมพ์บัตรคิว</button>
        </div>
      </section>
    </div>}
    {success && <section className="print-ticket" aria-hidden="true">
      <strong>บัตรคิว</strong>
      <span>สถานพยาบาล</span>
      <span>มหาวิทยาลัยเกษตรศาสตร์ วิทยาเขตกำแพงแสน</span>
      <hr />
      <small>หมายเลขคิว</small>
      <b>{success.ticketCode}</b>
      <span>{CATEGORY[success.category]?.label || 'ผู้ป่วยทั่วไป'}</span>
      <span>{new Date(success.issuedAt || Date.now()).toLocaleString('th-TH')}</span>
      <hr />
      <span>กรุณารับเอกสารและวางเอกสารในตะกร้า</span>
    </section>}
  </div></Shell>;
}

function HomeSelector() {
  const choices = [
    { icon: '▣', title: 'กดบัตรคิว', description: 'เลือกประเภทผู้รับบริการและรับหมายเลขคิว', path: '/kiosk' },
    { icon: '▤', title: 'หน้าแสดงคิว', description: 'ดูคิวที่กำลังเรียกและคิวถัดไป', path: '/display' },
    { icon: '⚙', title: 'เข้าสู่ระบบ', description: 'สำหรับเจ้าหน้าที่และระบบหลังบ้าน', path: '/login' },
  ];
  return <Shell simple><div className="entry-screen home-screen">
    <header className="kiosk-topbar"><span>สถานพยาบาล มหาวิทยาลัยเกษตรศาสตร์ วิทยาเขตกำแพงแสน</span><strong>ระบบรันคิว</strong></header>
    <main className="kiosk-content entry-content"><h1>ระบบรันคิว</h1><p className="home-intro">สะดวก รวดเร็ว ติดตามคิวได้ในที่เดียว</p><section className="kiosk-panel entry-panel">
      <div className="kiosk-panel-head"><strong>เลือกเมนูการใช้งาน</strong><span>เลือกบริการด้านล่างเพื่อเริ่มต้นใช้งาน</span></div>
      <div className="kiosk-options entry-options">{choices.map(choice => <button key={choice.path} className="kiosk-option entry-option" onClick={() => navigate(choice.path)}><span className="kiosk-icon" aria-hidden="true"><EntryIcon path={choice.path} /></span><strong>{choice.title}</strong><small>{choice.description}</small><span className="home-card-action">{choice.path === '/login' ? 'สำหรับเจ้าหน้าที่' : 'เริ่มใช้งาน'}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" /></svg></span></button>)}</div>
      <p className="kiosk-note">กรุณาเลือกเมนูที่ต้องการเพื่อเริ่มใช้งาน ระบบรันคิว</p>
    </section></main>
  </div></Shell>;
}

function EntryIcon({ path }) {
  if (path === '/kiosk') {
    return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="3" width="14" height="18" rx="3" /><path d="M9 8h6M9 12h6M9 16h3" /></svg>;
  }
  if (path === '/display') {
    return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4M7 9h4M7 12h8" /></svg>;
  }
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M5 21v-2a7 7 0 0 1 14 0v2" /></svg>;
}

function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  function submit(event) {
    event.preventDefault();
    const account = MOCK_STAFF_ACCOUNTS[username.trim().toLowerCase()];
    if (!account || account.password !== password) {
      setError('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
      return;
    }
    sessionStorage.setItem('queueflow-authenticated', 'true');
    sessionStorage.setItem('queueflow-operator-id', username.trim());
    sessionStorage.setItem('queueflow-service-point', String(account.point));
    sessionStorage.setItem('queueflow-staff-name', account.name);
    window.dispatchEvent(new Event('queueflow-auth-changed'));
    navigate('/operator');
  }
  return <Shell simple><div className="entry-screen login-screen">
    <header className="kiosk-topbar"><span>สถานพยาบาล มหาวิทยาลัยเกษตรศาสตร์ วิทยาเขตกำแพงแสน</span><strong>ระบบรันคิว</strong></header>
    <main className="kiosk-content"><div className="login-heading"><span className="login-emblem" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></svg></span><h1>เข้าสู่ระบบเจ้าหน้าที่</h1><p>จัดการคิวและติดตามการให้บริการของสถานพยาบาล</p></div><div className="login-layout"><form className="login-panel" onSubmit={submit}>
      <label>ชื่อผู้ใช้<input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" placeholder="กรอกชื่อผู้ใช้" /></label>
      <label>รหัสผ่าน<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" placeholder="กรอกรหัสผ่าน" /></label>
      {error && <p className="login-error" role="alert">{error}</p>}
      <button className="kiosk-confirm" type="submit">เข้าสู่ระบบ</button>
      <div className="login-separator"><span>หรือ</span></div>
      <button className="ku-alllogin-button" type="button" onClick={openKuAllLogin}>
        <span className="ku-alllogin-mark" aria-hidden="true">KU</span>
        <span><strong>เข้าสู่ระบบด้วย KU All-Login</strong><small>โหมดจำลองสำหรับการนำเสนอ</small></span>
      </button>
      <button className="login-back" type="button" onClick={() => navigate('/')}>กลับหน้าหลัก</button>
    </form><section className="mock-account-list"><strong>บัญชีทดลองเจ้าหน้าที่</strong><p className="mock-account-hint">เลือกบัญชีเพื่อกรอกชื่อผู้ใช้และรหัสผ่านอัตโนมัติ</p>{Object.entries(MOCK_STAFF_ACCOUNTS).map(([user, account]) => <button key={user} type="button" onClick={() => { setUsername(user); setPassword(account.password); setError(''); }}><span>{account.name}</span><small>{user} / test1234</small></button>)}</section></div></main>
  </div></Shell>;
}

function KuAllLoginMock() {
  return <Shell simple><div className="entry-screen login-screen ku-alllogin-screen">
    <header className="kiosk-topbar"><span>สถานพยาบาล มหาวิทยาลัยเกษตรศาสตร์ วิทยาเขตกำแพงแสน</span><strong>ระบบรันคิว</strong></header>
    <main className="kiosk-content">
      <section className="ku-alllogin-mock" aria-labelledby="ku-alllogin-title">
        <div className="ku-alllogin-brand"><span className="ku-alllogin-mark" aria-hidden="true">KU</span><span className="mock-badge">ระบบจำลอง</span></div>
        <h1 id="ku-alllogin-title">KU All-Login</h1>
        <p className="ku-alllogin-lead">ช่องทางเข้าสู่ระบบด้วยบัญชีมหาวิทยาลัยเกษตรศาสตร์</p>
        <output className="ku-alllogin-notice">
          <strong>ยังไม่ได้เชื่อมต่อระบบจริง</strong>
          <span>หน้านี้จัดทำเพื่อแสดงรูปแบบการเข้าสู่ระบบในอนาคตเท่านั้น และจะไม่ส่งข้อมูลหรือสร้างสิทธิ์เข้าใช้งาน</span>
        </output>
        <div className="ku-alllogin-flow" aria-label="ขั้นตอนการเชื่อมต่อในอนาคต">
          <div><b>1</b><span>ส่งผู้ใช้ไปยัง KU All-Login</span></div>
          <div><b>2</b><span>ยืนยันตัวตนด้วยบัญชีมหาวิทยาลัย</span></div>
          <div><b>3</b><span>กลับเข้าสู่ระบบรันคิวตามสิทธิ์</span></div>
        </div>
        <code className="ku-alllogin-path">เส้นทางที่เตรียมไว้: #{KU_ALLLOGIN_MOCK_PATH}</code>
        <button className="ku-alllogin-disabled" type="button" disabled>เชื่อมต่อ KU All-Login เมื่อพร้อมใช้งานจริง</button>
        <button className="login-back" type="button" onClick={() => navigate('/login')}>กลับไปเข้าสู่ระบบแบบเดิม</button>
      </section>
    </main>
  </div></Shell>;
}

function YourQueue({ ticket }) {
  const bg = ticket.category === 'emergency' ? emergencyQueueBg : generalQueueBg;
  return <Shell simple><div className="your-queue-screen" style={{ '--queue-bg': `url(${bg})` }}>
    <header className="kiosk-topbar"><span>สถานพยาบาล มหาวิทยาลัยเกษตรศาสตร์ วิทยาเขตกำแพงแสน</span></header>
    <main className="your-queue-content"><h1>คิวของคุณ</h1><section className="your-queue-card"><div className="your-queue-meta"><span>วันที่ / เดือน / ปี</span><b>{CATEGORY[ticket.category]?.label}</b></div><strong className="your-queue-label">หมายเลขคิวของคุณ</strong><div className="your-queue-number">{ticket.ticketCode}</div><p>จำนวนคิวก่อนหน้า -</p><p>โปรดตั้งเสียงสัญญาณ และจดหมายเลขคิวของคุณจากจอ</p></section><button className="back-home" onClick={() => navigate('/')}>กลับหน้าจอหลัก</button></main>
  </div></Shell>;
}

function ConfirmVisit() {
  return <Shell title="บัตรคิวของฉัน" role="ผู้รับบริการ"><main className="confirm-page"><div className="confirm-heading"><h1>ยืนยันการเข้ารับบริการ</h1><p>ตรวจสอบบริการที่เลือกและยืนยันการรับคิว</p></div><section className="confirm-card"><div className="confirm-category"><span>ประเภทบริการ</span><h2>การให้คำปรึกษาทางการเงิน</h2><b>⌂</b></div><div className="confirm-stats"><div><span>◷<small>เวลารอโดยประมาณ</small></span><strong>ประมาณ 18 นาที</strong></div><div><span>♟<small>จำนวนผู้รอก่อนหน้า</small></span><strong>4</strong></div></div><div className="confirm-body"><label>รับข้อความแจ้งเตือนทางโทรศัพท์ (ไม่บังคับ)<input placeholder="กรอกหมายเลขโทรศัพท์" /></label><p>เราจะส่งข้อความแจ้งเตือนเมื่อใกล้ถึงคิวของคุณ</p><button className="confirm-primary" onClick={() => navigate('/kiosk')}>ยืนยันและรับคิว</button><button className="confirm-secondary" onClick={() => navigate('/kiosk')}>เลือกบริการอื่น</button></div></section><p className="policy">เมื่อรับคิว ถือว่าคุณยอมรับ<u>เงื่อนไขการใช้บริการ</u>และ<u>นโยบายความเป็นส่วนตัว</u> อาจมีค่าบริการรับส่งข้อความตามเงื่อนไขของผู้ให้บริการ</p></main></Shell>;
}

function FigmaAdminNav({ active }) {
  const item = (key, label, icon, path) => <button className={active === key ? 'is-active' : ''} onClick={() => navigate(path)}>
    <img src={icon} alt="" />
    <span>{label}</span>
  </button>;
  return <aside className="figma-admin-nav">
    <div className="figma-admin-brand"><strong>ระบบเจ้าหน้าที่</strong><p>สถานพยาบาล มหาวิทยาลัยเกษตรศาสตร์ วิทยาเขตกำแพงแสน</p></div>
    <nav>
      {item('queue', 'เรียกคิว', adminPerson, '/operator')}
      {item('dashboard', 'ภาพรวม', adminDashboard, '/dashboard')}
    </nav>
  </aside>;
}

function logout() {
  ['queueflow-authenticated', 'queueflow-operator-id', 'queueflow-service-point', 'queueflow-staff-name']
    .forEach(key => sessionStorage.removeItem(key));
  navigate('/');
  window.dispatchEvent(new Event('queueflow-auth-changed'));
}


function FigmaAdminFrame({ active, title, children, action }) {
  return <div className="figma-admin-shell">
    <FigmaAdminNav active={active} />
    <div className="figma-admin-workspace">
      <header className="figma-admin-topbar"><strong>เจ้าหน้าที่</strong><img src={adminAccount} alt="บัญชีเจ้าหน้าที่" /><button type="button" className="logout-button" onClick={logout}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 17v3H4V4h6v3M14 8l4 4-4 4M9 12h12" /></svg>ออกจากระบบ</button></header>
      <main className="figma-admin-main">
        <div className="figma-admin-heading"><div><h1>{title}</h1><p>สถานพยาบาล มหาวิทยาลัยเกษตรศาสตร์ วิทยาเขตกำแพงแสน</p></div>{action}</div>
        {children}
      </main>
    </div>
  </div>;
}

function FigmaQueue({ queueData, actions, loading, error, staffPoint, staffName }) {
  const source = queueData || demoQueue();
  const all = source.tickets || [];
  const point = staffPoint || 1;
  const soundStorageKey = `queueflow-sound-point-${point}`;
  const [soundEnabled, setSoundEnabled] = useState(() => localStorage.getItem(`queueflow-sound-point-${staffPoint || 1}`) !== 'false');
  useEffect(() => {
    setSoundEnabled(localStorage.getItem(`queueflow-sound-point-${point}`) !== 'false');
  }, [point]);
  const points = source.servicePoints || [{ point: 1, name: 'เวชระเบียนและวัดค่าพื้นฐาน' }, { point: 3, name: 'คัดกรอง' }, { point: 4, name: 'พบแพทย์' }, { point: 6, name: 'ส่งใบสั่งยาและรับยา' }, { point: 7, name: 'ทำแผล' }];
  const selected = points.find(item => Number(item.point) === Number(point)) || points[0];
  const current = all.find(ticket => ticket.status === 'called' && Number(ticket.currentPoint) === Number(point));
  const waiting = all
    .filter(ticket => ticket.status === 'waiting' && Number(ticket.currentPoint) === Number(point))
    .sort((a, b) => new Date(a.arrivedAt || a.issuedAt).getTime() - new Date(b.arrivedAt || b.issuedAt).getTime() || Number(a.id) - Number(b.id));
  const skipped = all.filter(ticket => ticket.status === 'skipped' && Number(ticket.currentPoint) === Number(point));
  const announce = ticket => {
    if (soundEnabled && ticket?.ticketCode) speakQueue({ ...ticket, servicePoint: point });
  };
  const toggleSound = () => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    localStorage.setItem(soundStorageKey, String(next));
    if (!next) window.speechSynthesis?.cancel();
  };
  const callNext = async () => {
    try {
      const ticket = await actions.callNext(point);
      announce(ticket);
    } catch (requestError) {
      console.error('Call next queue failed', requestError);
    }
  };
  const recallQueue = async ticket => {
    try {
      const result = await actions.recall(ticket, point);
      announce(result?.ticketCode ? result : ticket);
    } catch (requestError) {
      console.error('Recall queue failed', requestError);
    }
  };
  const repeatQueue = async ticket => {
    try {
      const result = await actions.repeat(ticket, point);
      announce(result?.ticketCode ? result : ticket);
    } catch (requestError) {
      console.error('Repeat queue announcement failed', requestError);
    }
  };
  return <FigmaAdminFrame active="queue" title="เรียกหมายเลขคิว">
    <StatusBanner error={error} />
    <section className="figma-queue-layout">
      <div className="figma-current-card">
        <div className="figma-current-ticket">{current?.ticketCode || '—'}</div>
        <div className="figma-current-info"><strong>{staffName || 'เจ้าหน้าที่'}</strong><span>จุดบริการ {point} · {selected?.name}</span><button className={`sound-toggle ${soundEnabled ? 'enabled' : 'disabled'}`} type="button" aria-pressed={soundEnabled} onClick={toggleSound}>เสียงประกาศ: {soundEnabled ? 'เปิด' : 'ปิด'}</button></div>
      </div>
      <div className="figma-queue-actions">
        <button className="queue-action next" disabled={loading || Boolean(current) || !waiting.length} onClick={callNext}>เรียกคิว</button>
        {current && point === 1 && <button className="queue-action done" disabled={loading} onClick={() => actions.complete(current, 1)}>ส่งต่อไปจุดบริการ 3 <span>✓</span></button>}
        {current && point === 3 && <div className="doctor-routes"><button disabled={loading} onClick={() => actions.routeService(current, 3, 4)}>ส่งต่อไปจุดบริการ 4</button><button disabled={loading} onClick={() => actions.routeService(current, 3, 7)}>ส่งต่อไปจุดบริการ 7</button></div>}
        {current && point === 4 && <button className="queue-action done" disabled={loading} onClick={() => actions.complete(current, 4)}>ส่งต่อไปจุดบริการ 6 <span>✓</span></button>}
        {current && point === 7 && <div className="doctor-routes"><button disabled={loading} onClick={() => actions.routeService(current, 7, 4)}>ส่งต่อไปจุดบริการ 4</button><button disabled={loading} onClick={() => actions.routeService(current, 7, 6)}>ส่งต่อไปจุดบริการ 6</button><button disabled={loading} onClick={() => actions.routeService(current, 7, 'complete')}>เสร็จสิ้นการรับบริการ</button></div>}
        {current && point === 6 && <button className="queue-action done" disabled={loading} onClick={() => actions.complete(current, 6)}>เสร็จสิ้นการรับบริการ <span>✓</span></button>}
        <button className="queue-action skip" disabled={loading || !current} onClick={() => current && actions.skip(current, point)}>ข้ามคิว <span>↷</span></button>
        <button className="queue-action recall" disabled={loading || !current} onClick={() => current && repeatQueue(current)}>ประกาศคิวปัจจุบันซ้ำ <span>↻</span></button>
        {current && <p className="queue-action-hint">กำลังให้บริการ {current.ticketCode} ที่จุดบริการ {point}</p>}
      </div>
      <section className="figma-upcoming-card"><header><strong>คิวที่รอเรียก <small className="operator-queue-count">{waiting.length} คิว</small></strong><span>สถานะ</span><span>แก้ไข</span></header>
        {waiting.slice(0, 4).map(ticket => <div className="figma-upcoming-row" key={ticket.id}><strong>{ticket.ticketCode}</strong><span>จุดบริการ {point}</span><em className="status-waiting">รอเรียก</em><button onClick={() => actions.cancel(ticket)}>ลบคิว</button></div>)}
        {!waiting.length && <div className="figma-upcoming-empty">ไม่มีคิวถัดไป</div>}
      </section>
      {skipped.length > 0 && <section className="figma-skipped-card"><header><strong>คิวที่ข้ามไว้</strong><span>{current ? `ดำเนินการ ${current.ticketCode} ให้เสร็จก่อน แล้วเลือกเรียกคิวที่กลับมา` : 'จุดบริการว่าง เลือกเรียกคิวที่กลับมาได้'}</span></header>{skipped.map(ticket => <div className="figma-skipped-row" key={ticket.id}><strong>{ticket.ticketCode}</strong><span>{CATEGORY[ticket.category]?.label || 'ผู้ป่วยทั่วไป'}</span><button type="button" aria-label={`เรียกคิว ${ticket.ticketCode} อีกครั้ง`} title={current ? `กรุณาดำเนินการ ${current.ticketCode} ให้เสร็จก่อน` : `เรียก ${ticket.ticketCode} ที่จุดบริการ ${point}`} disabled={loading || Boolean(current)} onClick={() => recallQueue(ticket)}>เรียกคิวนี้อีกครั้ง</button></div>)}</section>}
    </section>
  </FigmaAdminFrame>;
}

function FigmaDashboard({ queueData, loading, error }) {
  const all = queueData?.tickets || [];
  const { metrics, loading: metricsLoading, error: metricsError, refresh: refreshMetrics } = useDashboardMetrics();
  const fallback = useMemo(() => buildDashboardFallback(all), [all]);
  const { source: data, bars, hourly, peakMax } = useMemo(
    () => buildDashboardViewModel(metrics || fallback, all),
    [metrics, fallback, all]
  );
  const dashboardError = error || metricsError;
  const dashboardLoading = loading || metricsLoading;
  const updatedAt = formatDashboardUpdatedAt(metrics?.generatedAt);
  let dashboardNote = 'โหมดสาธิต · ยังไม่ได้เชื่อมต่อระบบข้อมูล';
  if (dashboardLoading) dashboardNote = 'กำลังโหลดข้อมูล...';
  else if (updatedAt) dashboardNote = `อัปเดตล่าสุด ${updatedAt} · จากฐานข้อมูล`;

  return <FigmaAdminFrame active="dashboard" title="ภาพรวมการให้บริการ" action={<div className="figma-dashboard-actions"><button className="figma-refresh" disabled={dashboardLoading} onClick={refreshMetrics}>{dashboardLoading ? 'กำลังโหลด...' : 'โหลดข้อมูลใหม่'}</button></div>}>
    <StatusBanner error={dashboardError} />
    <DashboardReport queueData={queueData} />
    <section className="figma-dashboard-layout">
      <section className="figma-status-strip">
        <div><span>คิวที่กำลังรอ</span><strong>{Number(data.waiting || 0)}</strong></div>
        <div><span>คิวที่กำลังเรียก</span><strong>{Number(data.calling || 0)}</strong></div>
        <div><span>เสร็จสิ้นแล้ว</span><strong>{Number(data.completed || 0)}</strong></div>
        <div><span>คิวที่ข้ามไว้</span><strong>{Number(data.skipped || 0)}</strong></div>
      </section>
      <div className="figma-chart-card">
        <h2>ระยะเวลาและจำนวนผู้รับบริการในแต่ละจุดบริการ</h2>
        <div className="figma-chart-toolbar"><span>วันนี้ · {data.total ?? 0} รายการ</span><div><i className="legend-users" />จำนวนผู้รับบริการ <i className="legend-wait" />เวลารอเฉลี่ย <i className="legend-time" />เวลาให้บริการเฉลี่ย</div></div>
        <div className="figma-bars">{bars.map(bar => <div className="figma-bar-group" key={bar.label}><div className="figma-bar-pair"><span className="bar-users" style={{ height: `${bar.usersHeight}%` }} /><span className="bar-wait" style={{ height: `${bar.waitHeight}%` }} /><span className="bar-time" style={{ height: `${bar.minutesHeight}%` }} /></div><strong>{bar.label}</strong><small>{bar.users} คิว</small><small>รอ {bar.waitMinutes} นาที · บริการ {bar.minutes} นาที</small></div>)}</div>
      </div>
      <div className="figma-peak-card"><h2>ช่วงเวลาที่หนาแน่น</h2>{hourly.map(item => <div className={`peak-row ${Number(item.users) > 0 && Number(item.users) === peakMax ? 'is-peak' : ''}`} key={item.hour}><span>{String(item.hour).padStart(2, '0')}:00</span><i style={{ opacity: 0.2 + ((Number(item.users) || 0) / peakMax) * 0.8 }} /><strong>{Number(item.users) || 0} คิว</strong></div>)}</div>
      <div className="figma-stat-card"><span>จำนวนผู้เข้าใช้บริการ</span><strong>{Number(data.total || 0).toLocaleString()}</strong></div>
      <div className="figma-stat-card"><span>ระยะเวลาการรอเฉลี่ย</span><strong>{Number(data.averageWaitMinutes || 0)}<small> นาที</small></strong></div>
      <div className="figma-stat-card"><span>ระยะเวลาให้บริการเฉลี่ย</span><strong>{Number(data.averageServiceMinutes || 0)}<small> นาที</small></strong></div>
    </section>
    <p className="figma-data-note">{dashboardNote}</p>
  </FigmaAdminFrame>;
}

function DashboardReport({ queueData }) {
  const periods = [
    { value: 'today', label: 'วันนี้' },
    { value: 'week', label: 'สัปดาห์นี้' },
    { value: 'month', label: 'เดือนปัจจุบัน' },
    { value: 'three-months', label: '3 เดือนล่าสุด' },
    { value: 'academic-year', label: 'ปีการศึกษาปัจจุบัน' },
    { value: 'year', label: 'ปีปัจจุบัน' },
    { value: 'custom', label: 'กำหนดช่วงวันที่' },
  ];
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [range, setRange] = useState('month');
  const [customStart, setCustomStart] = useState(today);
  const [customEnd, setCustomEnd] = useState(today);
  const [reportData, setReportData] = useState(null);
  const [reportLoading, setReportLoading] = useState(true);
  const [reportError, setReportError] = useState('');
  const [exportError, setExportError] = useState('');
  const [exportingFormat, setExportingFormat] = useState('');
  const rangeLabel = Object.fromEntries(periods.map(item => [item.value, item.label]));
  useEffect(() => {
    if (range === 'custom' && (!customStart || !customEnd || customStart > customEnd)) {
      setReportError('ช่วงวันที่ไม่ถูกต้อง กรุณาตรวจสอบวันเริ่มต้นและวันสิ้นสุด');
      setReportLoading(false);
      return undefined;
    }
    let active = true;
    setReportLoading(true);
    setReportError('');
    apiRequest('getReport', { period: range, start: customStart, end: customEnd })
      .then(data => { if (active) setReportData(data); })
      .catch(error => { if (active) setReportError(error.message || 'โหลดข้อมูลรายงานไม่สำเร็จ'); })
      .finally(() => { if (active) setReportLoading(false); });
    return () => { active = false; };
  }, [range, customStart, customEnd]);
  const reportTickets = reportData?.tickets || (range === 'today' ? queueData?.tickets || [] : []);
  const displayDate = value => value ? new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value)) : '-';
  async function handleFormatAction(format) {
    setExportError('');
    const options = { tickets: reportTickets, periodLabel: rangeLabel[range], startDate: reportData?.startDate, endDate: reportData?.endDate };
    try {
      if (format === 'PDF') {
        printReport({ ...options, format });
        return;
      }
      setExportingFormat(format);
      if (format === 'Excel') await downloadExcelReport(options);
      else downloadCsvReport(options);
    } catch (error) {
      setExportError(error.message || `${format === 'PDF' ? 'เปิดหน้าพิมพ์' : 'ส่งออกไฟล์'} ${({ PDF: 'เอกสาร', Excel: 'ตารางคำนวณ', CSV: 'ข้อมูลแบบคั่นด้วยจุลภาค' })[format]} ไม่สำเร็จ`);
    } finally {
      setExportingFormat('');
    }
  }
  const formatLabels = { PDF: 'พิมพ์เอกสาร', Excel: 'ตารางคำนวณ', CSV: 'ข้อมูลแบบคั่นด้วยจุลภาค' };
  const formatButton = key => <button disabled={reportLoading || Boolean(reportError) || Boolean(exportingFormat)} onClick={() => handleFormatAction(key)}>{exportingFormat === key ? 'กำลังสร้าง...' : formatLabels[key]}</button>;
  return <section id="dashboard-report" className="dashboard-report-toolbar">
    <div className="dashboard-report-toolbar-copy"><strong>รายงาน</strong><span className={reportError || exportError ? 'is-error' : ''}>{reportError || exportError || (reportLoading ? 'กำลังโหลดข้อมูล...' : `${displayDate(reportData?.startDate)} – ${displayDate(reportData?.endDate)} · ${reportTickets.length} คิว`)}</span></div>
    <label className="dashboard-report-period"><span>ช่วงเวลา</span><select value={range} onChange={event => setRange(event.target.value)}>{periods.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
    {range === 'custom' && <div className="dashboard-report-dates"><label><span>วันที่เริ่มต้น</span><input type="date" value={customStart} max={customEnd || today} onChange={event => setCustomStart(event.target.value)} /></label><label><span>วันที่สิ้นสุด</span><input type="date" value={customEnd} min={customStart} max={today} onChange={event => setCustomEnd(event.target.value)} /></label></div>}
    <div className="dashboard-report-formats" aria-label="พิมพ์หรือส่งออกรายงาน">{formatButton('PDF')}{formatButton('Excel')}{formatButton('CSV')}</div>
  </section>;
}

function App() {
  const route = useHashRoute();
  const [, refreshAuth] = useReducer(version => version + 1, 0);
  useEffect(() => {
    const onAuthChanged = () => refreshAuth(version => version + 1);
    window.addEventListener('queueflow-auth-changed', onAuthChanged);
    return () => window.removeEventListener('queueflow-auth-changed', onAuthChanged);
  }, []);
  const { queue, setQueue, loading, error } = useQueueData();
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const mutate = useCallback(async (action, payload, localUpdate) => {
    setActionBusy(true);
    setActionError('');
    try {
      if (apiConfig.configured) {
        const requestPayload = { ...payload, operatorId: payload?.operatorId || sessionStorage.getItem('queueflow-operator-id') || '' };
        const data = await apiRequest(action, requestPayload);
        setQueue(data.queue || data);
        return data.ticket || data;
      }
      const result = localUpdate?.(queue || demoQueue()) || {};
      setQueue(result.queue || result);
      return result.ticket || result;
    } catch (err) {
      setActionError(err.message || 'ไม่สามารถดำเนินการกับคิวได้');
      throw err;
    } finally {
      setActionBusy(false);
    }
  }, [queue, setQueue]);
  const createTicket = useCallback((category, phone) => mutate('createTicket', { category, phone }, prev => {
    const n = prev.tickets.length + 1;
    const issuedAt = new Date().toISOString();
    const ticket = { id: `demo-${Date.now()}`, ticketCode: `Q${String(n).padStart(3, '0')}`, category, categoryLabel: CATEGORY[category].label, priority: category === 'emergency' ? 100 : 10, status: 'waiting', sequenceNo: n, issuedAt, arrivedAt: issuedAt, currentPoint: 1, phone };
    return { queue: { ...prev, tickets: [...prev.tickets, ticket] }, ticket };
  }), [mutate]);
  const ticketAction = useCallback((action, ticket) => mutate(action, { ticketId: ticket.id }, prev => {
    const nextStatus = { callTicket: 'called', skipTicket: 'skipped', recallTicket: 'called', completeTicket: 'completed', cancelTicket: 'cancelled' }[action];
    const updatedAt = new Date().toISOString();
    const updatedTicket = { ...ticket, status: nextStatus, updatedAt };
    if (nextStatus === 'called') updatedTicket.calledAt = updatedAt;
    if (nextStatus === 'skipped') updatedTicket.skippedAt = updatedAt;
    let nextCurrent = prev.current;
    if (nextStatus === 'called') nextCurrent = updatedTicket;
    else if (prev.current?.id === ticket.id) nextCurrent = null;
    return { ticket: updatedTicket, queue: { ...prev, tickets: prev.tickets.map(item => item.id === ticket.id ? updatedTicket : item), current: nextCurrent } };
  }), [mutate]);
  const actions = useMemo(() => ({
    callNext: (servicePoint = 1) => mutate('callNext', { servicePoint }, prev => {
      const waiting = prev.tickets
        .filter(ticket => ticket.status === 'waiting' && Number(ticket.currentPoint || 1) === Number(servicePoint))
        .sort((a, b) => new Date(a.arrivedAt || a.issuedAt).getTime() - new Date(b.arrivedAt || b.issuedAt).getTime() || (Number(a.sequenceNo) || 0) - (Number(b.sequenceNo) || 0));
      const next = waiting[0];
      if (!next) return { queue: prev };
      const updatedAt = new Date().toISOString();
      const updatedTicket = { ...next, status: 'called', calledAt: updatedAt, updatedAt };
      return { ticket: updatedTicket, queue: { ...prev, tickets: prev.tickets.map(item => item.id === next.id ? updatedTicket : item), current: updatedTicket } };
    }),
    call: ticket => ticketAction('callTicket', ticket), skip: (ticket, servicePoint) => mutate('skipTicket', { ticketId: ticket.id, servicePoint }), recall: (ticket, servicePoint) => mutate('recallTicket', { ticketId: ticket.id, servicePoint }, prev => {
      const updatedAt = new Date().toISOString();
      const updatedTicket = { ...ticket, status: 'called', calledAt: updatedAt, skippedAt: null, updatedAt };
      return { ticket: updatedTicket, queue: { ...prev, tickets: prev.tickets.map(item => item.id === ticket.id ? updatedTicket : item), current: updatedTicket } };
    }), repeat: (ticket, servicePoint) => mutate('repeatCall', { ticketId: ticket.id, servicePoint }, prev => {
      const updatedAt = new Date().toISOString();
      const updatedTicket = { ...ticket, calledAt: updatedAt, updatedAt };
      return { ticket: updatedTicket, queue: { ...prev, tickets: prev.tickets.map(item => item.id === ticket.id ? updatedTicket : item), current: updatedTicket } };
    }), complete: (ticket, servicePoint) => mutate('completeTicket', { ticketId: ticket.id, servicePoint }),
    routeService: (ticket, fromPoint, destination) => mutate('routeServiceTicket', { ticketId: ticket.id, fromPoint, destination }),
    cancel: ticket => ticketAction('cancelTicket', ticket),
  }), [mutate, ticketAction]);
  const adminRoute = ['/operator', '/admin-queue', '/dashboard', '/report'].includes(route);
  const authenticated = sessionStorage.getItem('queueflow-authenticated') === 'true';
  const staffPoint = Number(sessionStorage.getItem('queueflow-service-point')) || null;
  const staffName = sessionStorage.getItem('queueflow-staff-name') || '';
  const latestIssuedTicket = (queue?.tickets || []).reduce((latest, ticket) => {
    if (!latest) return ticket;
    const latestTime = new Date(latest.issuedAt || latest.createdAt || 0).getTime();
    const ticketTimeValue = new Date(ticket.issuedAt || ticket.createdAt || 0).getTime();
    if (ticketTimeValue !== latestTime) return ticketTimeValue > latestTime ? ticket : latest;
    return Number(ticket.sequenceNo || ticket.id || 0) > Number(latest.sequenceNo || latest.id || 0) ? ticket : latest;
  }, null);
  if (route === '/login') return <Login />;
  if (route === KU_ALLLOGIN_MOCK_PATH) return <KuAllLoginMock />;
  if (adminRoute && !authenticated) return <Login />;
  if (route === '/kiosk') return <Kiosk onCreate={createTicket} latestTicket={latestIssuedTicket} />;
  if (route === '/confirm') return <ConfirmVisit />;
  if (route === '/ticket/general') return <YourQueue ticket={{ ticketCode: 'Q001', category: 'general' }} />;
  if (route === '/ticket/emergency') return <YourQueue ticket={{ ticketCode: 'Q001', category: 'emergency' }} />;
  if (route === '/operator' || route === '/admin-queue') return <FigmaQueue queueData={queue} actions={actions} loading={loading || actionBusy} error={error || actionError} staffPoint={staffPoint} staffName={staffName} />;
  if (route === '/dashboard' || route === '/report') return <FigmaDashboard queueData={queue} loading={loading || actionBusy} error={error || actionError} />;
  if (route === '/display') return <QueueDisplay queueData={queue} />;
  return <HomeSelector />;
}

export default App;
