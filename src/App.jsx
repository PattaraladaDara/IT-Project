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
      <button className="brand" onClick={() => navigate('/')}>QueueFlow</button>
      <span className="topbar-title">{title}</span>
      <span className="role-chip">{role}</span>
    </header>}
    {children}
    {!simple && <footer className="footer"><strong>QueueFlow</strong><span>© 2024 QueueFlow Management Systems. All rights reserved.</span><nav><button onClick={() => navigate('/kiosk')}>Services</button><button onClick={() => navigate('/confirm')}>My Ticket</button><button>History</button></nav></footer>}
  </div>;
}

function PlainDisplayShell({ children }) {
  return <div className="app-shell plain-shell">{children}<footer className="footer"><strong>QueueFlow</strong><span>© 2024 QueueFlow Management Systems. All rights reserved.</span><nav><button onClick={() => navigate('/kiosk')}>Privacy Policy</button><button onClick={() => navigate('/operator')}>Terms of Service</button><button>Contact Support</button><button>About Us</button></nav></footer></div>;
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
      {/* <div className="queue-display-header-actions">
        <nav className="queue-display-nav" aria-label="เมนูหลัก">
          <button onClick={() => navigate('/operator')}>จัดการคิว</button>
          <button onClick={() => navigate('/dashboard')}>Dashboard</button>
          <button onClick={() => navigate('/kiosk')}>รับบัตรคิว</button>
          <button onClick={() => navigate('/confirm')}>ตรวจสอบคิว</button>
        </nav>
        <button className="queue-display-admin" onClick={() => navigate('/operator')} aria-label="เปิดหน้าจัดการคิว"><strong>Admin</strong><img src={adminAccount} alt="Admin account" /></button>
      </div> */}
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
          {!history.length && <div className="queue-display-history-empty">ยังไม่มีประวัติการเรียกคิว</div>}
        </div>
        <div className="queue-display-clock"><img src={queueAlarm} alt="" />{displayTime} น.</div>
      </aside>
      <section className="queue-display-upcoming-grid">
        {[4, 7].map(point => {
          const pointQueue = upcoming.filter(ticket => Number(ticket.currentPoint) === point);
          return <section className="queue-display-upcoming" key={point}>
            <header><h2>คิวรอจุดบริการ {point} ({pointQueue.length} คิว)</h2><strong>สถานะ</strong></header>
            <div className="queue-display-upcoming-list">
              {pointQueue.map(ticket => <div className="queue-display-upcoming-row" key={ticket.id}>
                <strong>{ticket.ticketCode}</strong><em>รอเรียก</em>
              </div>)}
              {!pointQueue.length && <div className="queue-display-history-empty">ไม่มีคิวรอเรียก</div>}
            </div>
          </section>;
        })}
      </section>
    </main>
  </div>;
}

function Kiosk({ onCreate }) {
  const [category, setCategory] = useState('');
  const [phone, setPhone] = useState('');
  const [success, setSuccess] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!success) return undefined;
    const timer = window.setTimeout(() => setSuccess(null), 1800);
    return () => window.clearTimeout(timer);
  }, [success]);
  async function submit() {
    if (!category) return;
    setBusy(true);
    try {
      const ticket = await onCreate(category, phone);
      setSuccess(ticket);
      setCategory('');
      setPhone('');
    }
    catch (err) { window.alert(err.message); }
    finally { setBusy(false); }
  }
  return <Shell simple><div className="kiosk-screen">
    <header className="kiosk-topbar"><span>คลินิกมหาวิทยาลัยเกษตรศาสตร์ วิทยาเขตกำแพงแสน</span></header>
    <main className="kiosk-content"><h1>กดรับบัตรคิว</h1><section className="kiosk-panel">
      <div className="kiosk-panel-head"><strong>เลือกบริการที่ต้องการ</strong></div>
      <div className="kiosk-options">{Object.entries(CATEGORY).map(([key, item]) => <button key={key} className={`kiosk-option ${category === key ? 'selected' : ''}`} onClick={() => setCategory(key)}><span className="kiosk-icon">{item.icon}</span><strong>{item.label}</strong></button>)}</div>
      <button className="kiosk-confirm" disabled={!category || busy} onClick={submit}>{busy ? 'กำลังออกคิว...' : 'ยืนยัน'}</button>
      {success && <output className="kiosk-success">
        <span>ออกบัตรคิวสำเร็จ · หมายเลข {success.ticketCode}</span>
        <button className="print-ticket-button" type="button" onClick={() => window.print()}>พิมพ์บัตรคิว</button>
      </output>}
      <p className="kiosk-note">คิวฉุกเฉินสามารถถูกจัดลำดับก่อนโดยเจ้าหน้าที่ และคิวที่ถูกข้ามจะถูกเรียกซ้ำภายหลัง</p>
    </section></main>
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
  return <Shell simple><div className="entry-screen">
    <header className="kiosk-topbar"><span>Medical facility Kasetsart University Kamphaeng Saen Campus Medical Clinic</span><strong>QueueFlow</strong></header>
    <main className="kiosk-content entry-content"><h1>QueueFlow</h1><section className="kiosk-panel entry-panel">
      <div className="kiosk-panel-head"><strong>เลือกเมนูการใช้งาน</strong><span>Select an option</span></div>
      <div className="kiosk-options entry-options">{choices.map(choice => <button key={choice.path} className="kiosk-option entry-option" onClick={() => navigate(choice.path)}><span className="kiosk-icon">{choice.icon}</span><strong>{choice.title}</strong><small>{choice.description}</small></button>)}</div>
      <p className="kiosk-note">กรุณาเลือกเมนูที่ต้องการเพื่อเริ่มใช้งาน QueueFlow</p>
    </section></main>
  </div></Shell>;
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
    <header className="kiosk-topbar"><span>Medical facility Kasetsart University Kamphaeng Saen Campus Medical Clinic</span><strong>QueueFlow</strong></header>
    <main className="kiosk-content"><h1>เข้าสู่ระบบ</h1><form className="login-panel" onSubmit={submit}>
      <label>ชื่อผู้ใช้<input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" /></label>
      <label>รหัสผ่าน<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" /></label>
      {error && <p className="login-error" role="alert">{error}</p>}
      <button className="kiosk-confirm" type="submit">เข้าสู่ระบบ</button>
      <button className="login-back" type="button" onClick={() => navigate('/')}>กลับหน้าหลัก</button>
    </form><section className="mock-account-list"><strong>บัญชีทดลองเจ้าหน้าที่</strong>{Object.entries(MOCK_STAFF_ACCOUNTS).map(([user, account]) => <button key={user} type="button" onClick={() => { setUsername(user); setPassword(account.password); setError(''); }}><span>{account.name}</span><small>{user} / test1234</small></button>)}</section></main>
  </div></Shell>;
}

function YourQueue({ ticket }) {
  const bg = ticket.category === 'emergency' ? emergencyQueueBg : generalQueueBg;
  return <Shell simple><div className="your-queue-screen" style={{ '--queue-bg': `url(${bg})` }}>
    <header className="kiosk-topbar"><span>Medical facility Kasetsart University Kamphaeng Saen Campus Medical Clinic</span></header>
    <main className="your-queue-content"><h1>Your Queue</h1><section className="your-queue-card"><div className="your-queue-meta"><span>วันที่ / เดือน / ปี</span><b>{CATEGORY[ticket.category]?.label}</b></div><strong className="your-queue-label">หมายเลขคิวของคุณ</strong><div className="your-queue-number">{ticket.ticketCode}</div><p>จำนวนคิวก่อนหน้า -</p><p>โปรดตั้งเสียงสัญญาณ และจดหมายเลขคิวของคุณจากจอ</p></section><button className="back-home" onClick={() => navigate('/')}>กลับหน้าจอหลัก</button></main>
  </div></Shell>;
}

function ConfirmVisit() {
  return <Shell title="My Ticket" role="ผู้รับบริการ"><main className="confirm-page"><div className="confirm-heading"><h1>Confirm Your Visit</h1><p>Review your selection and join the queue.</p></div><section className="confirm-card"><div className="confirm-category"><span>CATEGORY</span><h2>Financial Advising</h2><b>⌂</b></div><div className="confirm-stats"><div><span>◷<small>Wait Time</small></span><strong>~18 min</strong></div><div><span>♟<small>People Ahead</small></span><strong>4</strong></div></div><div className="confirm-body"><label>SMS Notifications (Optional)<input placeholder="+1 (555) 000-0000" /></label><p>We'll text you when it's almost your turn.</p><button className="confirm-primary" onClick={() => navigate('/kiosk')}>Confirm and Join Queue</button><button className="confirm-secondary" onClick={() => navigate('/kiosk')}>Select Different Service</button></div></section><p className="policy">By joining, you agree to our <u>Service Terms</u> and <u>Privacy Policy</u>. Data rates may apply for SMS.</p></main></Shell>;
}

function AdminQueueCard({ ticket, actions }) {
  const category = CATEGORY[ticket.category] || CATEGORY.general;
  return <article className="admin-queue-card"><span className="admin-category">{category.label}</span><div className="admin-ticket-number">{ticket.ticketCode}</div><div className="admin-card-actions"><button className="admin-call" onClick={() => actions.call(ticket)}>เรียกคิว</button><button className="admin-cancel" onClick={() => actions.cancel(ticket)}>ยกเลิก</button></div></article>;
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

function FigmaAdminFrame({ active, title, children, action }) {
  return <div className="figma-admin-shell">
    <FigmaAdminNav active={active} />
    <div className="figma-admin-workspace">
      <header className="figma-admin-topbar"><strong>เจ้าหน้าที่</strong><img src={adminAccount} alt="บัญชีเจ้าหน้าที่" /></header>
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
  const [point, setPoint] = useState(staffPoint || 1);
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
  const callNext = async () => { try { const ticket = await actions.callNext(point); announce(ticket); } catch (_) {} };
  const recallQueue = async ticket => { try { const result = await actions.recall(ticket, point); announce(result?.ticketCode ? result : ticket); } catch (_) {} };
  const repeatQueue = async ticket => { try { const result = await actions.repeat(ticket, point); announce(result?.ticketCode ? result : ticket); } catch (_) {} };
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
        {current && point === 7 && <div className="doctor-routes"><button disabled={loading} onClick={() => actions.routeService(current, 7, 4)}>ส่งต่อไปจุดบริการ 4</button><button disabled={loading} onClick={() => actions.routeService(current, 7, 'complete')}>เสร็จสิ้นการรับบริการ</button></div>}
        {current && point === 6 && <button className="queue-action done" disabled={loading} onClick={() => actions.complete(current, 6)}>เสร็จสิ้นการรับบริการ <span>✓</span></button>}
        <button className="queue-action skip" disabled={loading || !current} onClick={() => current && actions.skip(current, point)}>ข้ามคิว <span>↷</span></button>
        <button className="queue-action recall" disabled={loading || (!skipped.length && !current)} onClick={() => skipped[0] ? recallQueue(skipped[0]) : current && repeatQueue(current)}>เรียกคิวซ้ำ <span>↻</span></button>
        {current && <p className="queue-action-hint">กำลังให้บริการ {current.ticketCode} ที่จุดบริการ {point}</p>}
      </div>
      <section className="figma-upcoming-card"><header><strong>Upcoming Queue</strong><span>สถานะ</span><span>แก้ไข</span></header>
        {waiting.slice(0, 4).map(ticket => <div className="figma-upcoming-row" key={ticket.id}><strong>{ticket.ticketCode}</strong><span>จุดบริการ {point}</span><em className="status-waiting">รอเรียก</em><button onClick={() => actions.cancel(ticket)}>ลบคิว</button></div>)}
        {!waiting.length && <div className="figma-upcoming-empty">ไม่มีคิวถัดไป</div>}
      </section>
      {skipped.length > 0 && <section className="figma-skipped-card"><header><strong>คิวที่ข้ามไว้</strong><span>สามารถเรียกซ้ำภายหลังได้</span></header>{skipped.map(ticket => <div className="figma-skipped-row" key={ticket.id}><strong>{ticket.ticketCode}</strong><span>{CATEGORY[ticket.category]?.label || 'ผู้ป่วยทั่วไป'}</span><button disabled={loading} onClick={() => recallQueue(ticket)}>เรียกคิวซ้ำ</button></div>)}</section>}
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

  return <FigmaAdminFrame active="dashboard" title="ภาพรวมการให้บริการ" action={<div className="figma-dashboard-actions"><button className="figma-refresh" disabled={dashboardLoading} onClick={refreshMetrics}>{dashboardLoading ? 'กำลังโหลด...' : 'รีเฟรช'}</button></div>}>
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
      setExportError(error.message || `${format === 'PDF' ? 'เปิดหน้าพิมพ์' : 'ส่งออกไฟล์'} ${format} ไม่สำเร็จ`);
    } finally {
      setExportingFormat('');
    }
  }
  const formatButton = key => <button disabled={reportLoading || Boolean(reportError) || Boolean(exportingFormat)} onClick={() => handleFormatAction(key)}>{exportingFormat === key ? 'กำลังสร้าง...' : key}</button>;
  return <section id="dashboard-report" className="dashboard-report-toolbar">
    <div className="dashboard-report-toolbar-copy"><strong>รายงาน</strong><span className={reportError || exportError ? 'is-error' : ''}>{reportError || exportError || (reportLoading ? 'กำลังโหลดข้อมูล...' : `${displayDate(reportData?.startDate)} – ${displayDate(reportData?.endDate)} · ${reportTickets.length} คิว`)}</span></div>
    <label className="dashboard-report-period"><span>ช่วงเวลา</span><select value={range} onChange={event => setRange(event.target.value)}>{periods.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
    {range === 'custom' && <div className="dashboard-report-dates"><label><span>วันที่เริ่มต้น</span><input type="date" value={customStart} max={customEnd || today} onChange={event => setCustomStart(event.target.value)} /></label><label><span>วันที่สิ้นสุด</span><input type="date" value={customEnd} min={customStart} max={today} onChange={event => setCustomEnd(event.target.value)} /></label></div>}
    <div className="dashboard-report-formats" aria-label="พิมพ์หรือส่งออกรายงาน">{formatButton('PDF')}{formatButton('Excel')}{formatButton('CSV')}</div>
  </section>;
}

function Operator({ queueData, actions, loading, error }) {
  const all = queueData?.tickets || [];
  const active = all.filter(t => ['waiting', 'called', 'serving'].includes(t.status));
  const skipped = all.filter(t => t.status === 'skipped');
  return <PlainDisplayShell><section className="hero admin-hero"><div className="hero-inner"><h1>ระบบจัดลำดับการใช้บริการสถานพยาบาล</h1><p>Kasetsart University Kampangsan Campus</p></div></section><main className="admin-page"><StatusBanner error={error} /><div className="admin-toolbar"><span>คิววันนี้ · {active.length + skipped.length} รายการ</span><button className="button primary" disabled={loading} onClick={actions.callNext}>เรียกคิวถัดไป</button></div><div className="admin-grid">{active.map(ticket => <AdminQueueCard key={ticket.id} ticket={ticket} actions={actions} />)}</div>{skipped.length > 0 && <section className="skipped-panel"><h2>คิวที่ถูกข้าม · เรียกซ้ำภายหลัง</h2><div className="skipped-list">{skipped.map(ticket => <div key={ticket.id}><strong>{ticket.ticketCode}</strong><span>{CATEGORY[ticket.category]?.label}</span><button className="button secondary small" onClick={() => actions.recall(ticket)}>เรียกซ้ำ</button></div>)}</div></section>}</main></PlainDisplayShell>;
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
    call: ticket => ticketAction('callTicket', ticket), skip: (ticket, servicePoint) => mutate('skipTicket', { ticketId: ticket.id, servicePoint }), recall: (ticket, servicePoint) => mutate('recallTicket', { ticketId: ticket.id, servicePoint }), repeat: (ticket, servicePoint) => mutate('repeatCall', { ticketId: ticket.id, servicePoint }, prev => {
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
  if (route === '/login') return <Login />;
  if (adminRoute && !authenticated) return <Login />;
  if (route === '/kiosk') return <Kiosk onCreate={createTicket} />;
  if (route === '/confirm') return <ConfirmVisit />;
  if (route === '/ticket/general') return <YourQueue ticket={{ ticketCode: 'Q001', category: 'general' }} />;
  if (route === '/ticket/emergency') return <YourQueue ticket={{ ticketCode: 'Q001', category: 'emergency' }} />;
  if (route === '/operator' || route === '/admin-queue') return <FigmaQueue queueData={queue} actions={actions} loading={loading || actionBusy} error={error || actionError} staffPoint={staffPoint} staffName={staffName} />;
  if (route === '/dashboard' || route === '/report') return <FigmaDashboard queueData={queue} loading={loading || actionBusy} error={error || actionError} />;
  if (route === '/display') return <QueueDisplay queueData={queue} />;
  return <HomeSelector />;
}

export default App;
