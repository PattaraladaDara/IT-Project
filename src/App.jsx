import React, { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { apiConfig, apiRequest, demoQueue } from './api.js';
import generalQueueBg from './assets/queue-general-bg.png';
import emergencyQueueBg from './assets/queue-emergency-bg.png';
import reportClinic from './assets/report-clinic.png';
import reportPdf from './assets/report-pdf.png';
import reportExcel from './assets/report-excel.png';
import reportCsv from './assets/report-csv.svg';
import adminPerson from './assets/admin-person.svg';
import adminAccount from './assets/admin-account.svg';
import adminDashboard from './assets/admin-dashboard.svg';
import adminReport from './assets/admin-report.svg';
import queueAlarm from './assets/queue-alarm.svg';
import { speakQueue } from './speech.js';
import { useDashboardMetrics } from './hooks/useDashboardMetrics.js';
import { useQueueData } from './hooks/useQueueData.js';
import { buildDashboardFallback, buildDashboardViewModel, formatDashboardUpdatedAt } from './dashboardMetrics.js';

const CATEGORY = {
  general: { label: 'ผู้ป่วยทั่วไป', description: 'รับบริการตามลำดับคิวปกติ', color: 'blue', icon: '▣' },
  emergency: { label: 'อุบัติเหตุ', description: 'เจ้าหน้าที่สามารถจัดลำดับก่อนเมื่อจำเป็น', color: 'red', icon: '✚' },
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
  const [route, setRoute] = useState(() => window.location.hash.replace(/^#/, '') || '/');
  useEffect(() => {
    const update = () => setRoute(window.location.hash.replace(/^#/, '') || '/');
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
    <div className="display-service"><strong>{category.label}</strong><span>ช่องบริการหมายเลข 2</span></div>
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
  const latestFor = category => called.find(ticket => ticket.category === category)
    || (apiConfig.configured ? { ticketCode: '—', category } : demoCurrent[category]);
  const general = latestFor('general');
  const emergency = latestFor('emergency');
  const upcoming = active
    .filter(ticket => ticket.id !== general.id && ticket.id !== emergency.id && ticket.status !== 'skipped')
    .sort((a, b) => (Number(a.sequenceNo) || 0) - (Number(b.sequenceNo) || 0))
    .slice(0, 4);
  const history = (source.history || (apiConfig.configured
    ? called.filter(ticket => ticket !== general && ticket !== emergency)
    : [{ id: 'demo-history-1', ticketCode: 'Q068', counter: 3 }, { id: 'demo-history-2', ticketCode: 'Q069', counter: 4 }, { id: 'demo-history-3', ticketCode: 'Q070', counter: 5 }]))
    .filter(ticket => ticket.id !== general.id && ticket.id !== emergency.id)
    .slice(0, 3);
  const displayTime = new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const categoryLabel = ticket => CATEGORY[ticket.category]?.label || ticket.categoryLabel || 'ผู้ป่วยทั่วไป';
  return <div className="queue-display-shell">
    <header className="queue-display-header">
      <div>
        <h1>Call the queue number</h1>
        <p>Medical facility Kasetsart University Kamphaeng Saen Campus Medical Clinic</p>
      </div>
      {/* <div className="queue-display-header-actions">
        <nav className="queue-display-nav" aria-label="เมนูหลัก">
          <button onClick={() => navigate('/operator')}>จัดการคิว</button>
          <button onClick={() => navigate('/dashboard')}>Dashboard</button>
          <button onClick={() => navigate('/report')}>รายงาน</button>
          <button onClick={() => navigate('/kiosk')}>รับบัตรคิว</button>
          <button onClick={() => navigate('/confirm')}>ตรวจสอบคิว</button>
        </nav>
        <button className="queue-display-admin" onClick={() => navigate('/operator')} aria-label="เปิดหน้าจัดการคิว"><strong>Admin</strong><img src={adminAccount} alt="Admin account" /></button>
      </div> */}
    </header>
    <main className="queue-display-main">
      <section className="queue-display-current-grid">
        {[general, emergency].map(ticket => <article className="queue-display-current" key={ticket.category}>
          <div className="queue-display-number">{ticket.ticketCode}</div>
          <div className="queue-display-current-copy"><strong>{categoryLabel(ticket)}</strong><span>ช่องบริการหมายเลข {ticket.category === 'emergency' ? '7' : '3'}</span></div>
        </article>)}
      </section>
      <aside className="queue-display-history">
        <h2>คิวที่เรียกไปแล้ว</h2>
        <div className="queue-display-history-list">
          {history.map((ticket, index) => <div className="queue-display-history-row" key={ticket.id || `${ticket.ticketCode}-${index}`}><strong>{ticket.ticketCode}</strong><span>ช่องบริการหมายเลข {ticket.counter || (index + 3)}</span></div>)}
          {!history.length && <div className="queue-display-history-empty">ยังไม่มีประวัติการเรียกคิว</div>}
        </div>
        <div className="queue-display-clock"><img src={queueAlarm} alt="" />{displayTime} น.</div>
      </aside>
      <section className="queue-display-upcoming">
        <header><h2>Upcoming Queue</h2><strong>สถานะ</strong></header>
        <div className="queue-display-upcoming-list">
          {upcoming.map(ticket => <div className="queue-display-upcoming-row" key={ticket.id}>
            <strong>{ticket.ticketCode}</strong><span>ช่องบริการหมายเลข {ticket.counter || '1'}</span><em>{ticket.status === 'skipped' ? 'ข้ามคิว' : 'กำลังดำเนินการ'}</em>
          </div>)}
          {!upcoming.length && <div className="queue-display-history-empty">ไม่มีคิวถัดไป</div>}
        </div>
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
    if (!username.trim() || !password) {
      setError('กรุณากรอกชื่อผู้ใช้และรหัสผ่าน');
      return;
    }
    sessionStorage.setItem('queueflow-authenticated', 'true');
    sessionStorage.setItem('queueflow-operator-id', username.trim());
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
    </form></main>
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
    <div className="figma-admin-brand"><strong>Admin</strong><p>Medical facility Kasetsart University Kamphaeng Saen Campus Medical Clinic</p></div>
    <nav>
      {item('queue', 'Queue', adminPerson, '/operator')}
      {item('dashboard', 'Dashboard', adminDashboard, '/dashboard')}
      {item('report', 'Report', adminReport, '/report')}
    </nav>
  </aside>;
}

function FigmaAdminFrame({ active, title, children, action }) {
  return <div className="figma-admin-shell">
    <FigmaAdminNav active={active} />
    <div className="figma-admin-workspace">
      <header className="figma-admin-topbar"><strong>Admin</strong><img src={adminAccount} alt="Admin account" /></header>
      <main className="figma-admin-main">
        <div className="figma-admin-heading"><div><h1>{title}</h1><p>Medical facility Kasetsart University Kamphaeng Saen Campus Medical Clinic</p></div>{action}</div>
        {children}
      </main>
    </div>
  </div>;
}

function FigmaQueue({ queueData, actions, loading, error }) {
  const source = queueData || demoQueue();
  const all = source.tickets || [];
  const active = all.filter(ticket => ['waiting', 'called', 'serving', 'skipped'].includes(ticket.status));
  const current = source.current && ['called', 'serving'].includes(source.current.status)
    ? source.current
    : active.find(ticket => ['called', 'serving'].includes(ticket.status)) || null;
  const waiting = active
    .filter(ticket => ticket.status === 'waiting')
    .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0) || (Number(a.sequenceNo) || 0) - (Number(b.sequenceNo) || 0));
  const skipped = active.filter(ticket => ticket.status === 'skipped');
  const upcoming = waiting.slice(0, 4);
  const statusLabel = ticket => {
    if (ticket.status === 'waiting') return 'รอเรียก';
    if (ticket.status === 'called' || ticket.status === 'serving') return 'กำลังดำเนินการ';
    return 'ข้ามคิว';
  };
  async function handleCallNext() {
    try {
      const ticket = await actions.callNext();
      if (ticket?.ticketCode) speakQueue(ticket);
    } catch (error) { /* The action error is shown by the status banner. */ }
  }
  async function handleRecall(ticket) {
    try {
      const recalled = await actions.recall(ticket);
      speakQueue(recalled?.ticketCode ? recalled : ticket);
    } catch (error) { /* The action error is shown by the status banner. */ }
  }
  async function handleRepeat(ticket) {
    try {
      const repeated = await actions.repeat(ticket);
      speakQueue(repeated?.ticketCode ? repeated : ticket);
    } catch (error) { /* The action error is shown by the status banner. */ }
  }
  return <FigmaAdminFrame active="queue" title="Call the queue number">
    <StatusBanner error={error} />
    <section className="figma-queue-layout">
      <div className="figma-current-card">
        <div className="figma-current-ticket">{current?.ticketCode || '—'}</div>
        <div className="figma-current-info"><strong>{current ? (CATEGORY[current.category]?.label || current.categoryLabel || 'ผู้ป่วยทั่วไป') : 'ยังไม่มีคิวที่กำลังเรียก'}</strong><span>{current ? 'ช่องบริการหมายเลข 2' : 'กด “เรียกคิว” เพื่อเริ่มให้บริการ'}</span></div>
      </div>
      <div className="figma-queue-actions">
        <button className="queue-action next" disabled={loading || Boolean(current) || !waiting.length} onClick={handleCallNext}>เรียกคิว</button>
        <button className="queue-action done" disabled={loading || !current} onClick={() => current && actions.complete(current)}>เสร็จสิ้น <span>✓</span></button>
        <button className="queue-action skip" disabled={loading || !current} onClick={() => current && actions.skip(current)}>ข้ามคิว <span>↷</span></button>
        <button className="queue-action recall" disabled={loading || (!skipped.length && !current)} onClick={() => skipped[0] ? handleRecall(skipped[0]) : current && handleRepeat(current)}>เรียกคิวซ้ำ <span>↻</span></button>
        {current && <p className="queue-action-hint">กำลังให้บริการ {current.ticketCode}<br />กด “เรียกคิวซ้ำ” เพื่อประกาศอีกครั้ง หรือกด “เสร็จสิ้น” / “ข้ามคิว” ก่อนเรียกคิวถัดไป</p>}
        {!current && !waiting.length && <p className="queue-action-hint">ไม่มีคิวที่รอเรียก</p>}
      </div>
      <section className="figma-upcoming-card">
        <header><strong>Upcoming Queue</strong><span>สถานะ</span><span>แก้ไข</span></header>
        {upcoming.map(ticket => <div className="figma-upcoming-row" key={ticket.id}>
          <strong>{ticket.ticketCode}</strong><span>ช่องบริการหมายเลข 1</span><em className={`status-${ticket.status}`}>{statusLabel(ticket)}</em><button onClick={() => actions.cancel(ticket)}>ลบคิว</button>
        </div>)}
        {!upcoming.length && <div className="figma-upcoming-empty">ไม่มีคิวถัดไป</div>}
      </section>
      {skipped.length > 0 && <section className="figma-skipped-card">
        <header><strong>คิวที่ข้ามไว้</strong><span>สามารถเรียกซ้ำภายหลังได้</span></header>
        {skipped.map(ticket => <div className="figma-skipped-row" key={ticket.id}>
          <strong>{ticket.ticketCode}</strong><span>{CATEGORY[ticket.category]?.label || ticket.categoryLabel || 'ผู้ป่วยทั่วไป'}</span>
          <button disabled={loading} onClick={() => handleRecall(ticket)}>เรียกคิวซ้ำ</button>
        </div>)}
      </section>}
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
  let dashboardNote = 'โหมดสาธิต · ยังไม่ได้เชื่อมต่อ API';
  if (dashboardLoading) dashboardNote = 'กำลังโหลดข้อมูล...';
  else if (updatedAt) dashboardNote = `อัปเดตล่าสุด ${updatedAt} · จาก PostgreSQL API`;

  return <FigmaAdminFrame active="dashboard" title="Dashboard" action={<div className="figma-dashboard-actions"><button className="figma-refresh" disabled={dashboardLoading} onClick={refreshMetrics}>{dashboardLoading ? 'กำลังโหลด...' : 'รีเฟรช'}</button><button className="figma-export" onClick={() => navigate('/report')}>ส่งออกรายงาน <span>↥</span></button></div>}>
    <StatusBanner error={dashboardError} />
    <section className="figma-dashboard-layout">
      <div className="figma-chart-card">
        <h2>ระยะเวลา และ ปริมาณผู้เข้าใช้บริการในแต่ละจุดบริการ</h2>
        <div className="figma-chart-toolbar"><span>วันนี้ · {data.total ?? 0} รายการ</span><div><i className="legend-users" />ผู้รับบริการ <i className="legend-time" />ระยะเวลา (นาที)</div></div>
        <div className="figma-bars">{bars.map(bar => <div className="figma-bar-group" key={bar.label}><div className="figma-bar-pair"><span className="bar-users" style={{ height: `${bar.usersHeight}%` }} /><span className="bar-time" style={{ height: `${bar.minutesHeight}%` }} /></div><strong>{bar.label}</strong></div>)}</div>
      </div>
      <div className="figma-peak-card"><h2>ช่วงเวลาที่หนาแน่น</h2>{hourly.map(item => <div className="peak-row" key={item.hour}><span>{String(item.hour).padStart(2, '0')}:00</span><i style={{ opacity: 0.25 + ((Number(item.users) || 0) / peakMax) * 0.75 }} /></div>)}</div>
      <div className="figma-stat-card"><span>จำนวนผู้เข้าใช้บริการ</span><strong>{Number(data.total || 0).toLocaleString()}</strong></div>
      <div className="figma-stat-card"><span>ระยะเวลาการรอเฉลี่ย</span><strong>{Number(data.averageWaitMinutes || 0)}<small> นาที</small></strong></div>
      <div className="figma-stat-card"><span>ระยะเวลาการให้บริการ</span><strong>{Number(data.averageServiceMinutes || 0)}<small> นาที</small></strong></div>
    </section>
    <p className="figma-data-note">{dashboardNote}</p>
  </FigmaAdminFrame>;
}

function FigmaReport({ queueData, error }) {
  const [reportType, setReportType] = useState('overview');
  const [range, setRange] = useState('today');
  const [format, setFormat] = useState('PDF');
  function exportReport() {
    if (format === 'CSV') {
      const rows = [['ticketCode', 'category', 'status', 'issuedAt'], ...(queueData?.tickets || []).map(ticket => [ticket.ticketCode, ticket.category, ticket.status, ticket.issuedAt])];
      const blob = new Blob([rows.map(row => row.map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `queueflow-${range}.csv`; link.click(); URL.revokeObjectURL(url); return;
    }
    window.alert(`เตรียมสร้างรายงาน ${format} (${reportType === 'overview' ? 'สรุปภาพรวมการใช้บริการ' : 'รายละเอียดส่วนบุคคล'})`);
  }
  const reportCard = (key, title, text) => <button className={`report-type-card ${reportType === key ? 'selected' : ''}`} onClick={() => setReportType(key)}><strong>{title}</strong><span>{text}</span><b>✓</b></button>;
  const rangeButton = (key, label) => <button className={range === key ? 'selected' : ''} onClick={() => setRange(key)}>{label}</button>;
  const fileCard = (key, label, image) => <button className={`report-file-card ${format === key ? 'selected' : ''}`} onClick={() => setFormat(key)}><img src={image} alt="" /><strong>{label}</strong></button>;
  return <FigmaAdminFrame active="report" title="Report"><StatusBanner error={error} /><section className="figma-report-layout">
    <div className="figma-report-main">
      <section className="report-section report-type"><div className="report-section-heading"><h2>ประเภทรายงาน</h2><span>เดือน มิถุนายน⌄</span></div><div className="report-type-grid">{reportCard('overview', 'สรุปภาพรวมการใช้บริการ', 'สถิติการเข้าใช้บริการ และ ระยะเวลาเฉลี่ยรายวัน')}{reportCard('personal', 'รายละเอียดส่วนบุคคล', 'ประวัติการเข้าใช้สถานพยาบาล พร้อมคำวินิจฉัยเบื้องต้น')}</div></section>
      <section className="report-section report-options"><h2>ช่วงเวลาของข้อมูล</h2><div className="report-pills">{rangeButton('today', 'วันนี้')}{rangeButton('week', '7 วันที่ผ่านมา')}{rangeButton('month', 'รายเดือน')}</div><h2>รูปแบบไฟล์</h2><div className="report-file-grid">{fileCard('PDF', 'PDF', reportPdf)}{fileCard('Excel', 'Excel', reportExcel)}{fileCard('CSV', 'CSV', reportCsv)}</div><button className="report-download" onClick={exportReport}>ดาวน์โหลดรายงาน</button></section>
    </div>
    <img className="report-clinic-image" src={reportClinic} alt="Medical clinic" />
  </section></FigmaAdminFrame>;
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
    const ticket = { id: `demo-${Date.now()}`, ticketCode: `Q${String(n).padStart(3, '0')}`, category, categoryLabel: CATEGORY[category].label, priority: category === 'emergency' ? 100 : 10, status: 'waiting', sequenceNo: n, issuedAt: new Date().toISOString(), phone };
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
    callNext: () => mutate('callNext', {}, prev => {
      const waiting = prev.tickets.filter(ticket => ticket.status === 'waiting').sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0) || (Number(a.sequenceNo) || 0) - (Number(b.sequenceNo) || 0));
      const next = waiting[0];
      if (!next) return { queue: prev };
      const updatedAt = new Date().toISOString();
      const updatedTicket = { ...next, status: 'called', calledAt: updatedAt, updatedAt };
      return { ticket: updatedTicket, queue: { ...prev, tickets: prev.tickets.map(item => item.id === next.id ? updatedTicket : item), current: updatedTicket } };
    }),
    call: ticket => ticketAction('callTicket', ticket), skip: ticket => ticketAction('skipTicket', ticket), recall: ticket => ticketAction('recallTicket', ticket), repeat: ticket => mutate('repeatCall', { ticketId: ticket.id }, prev => {
      const updatedAt = new Date().toISOString();
      const updatedTicket = { ...ticket, calledAt: updatedAt, updatedAt };
      return { ticket: updatedTicket, queue: { ...prev, tickets: prev.tickets.map(item => item.id === ticket.id ? updatedTicket : item), current: updatedTicket } };
    }), complete: ticket => ticketAction('completeTicket', ticket), cancel: ticket => ticketAction('cancelTicket', ticket),
  }), [mutate, ticketAction]);
  const adminRoute = ['/operator', '/admin-queue', '/dashboard', '/report'].includes(route);
  const authenticated = sessionStorage.getItem('queueflow-authenticated') === 'true';
  if (route === '/login') return <Login />;
  if (adminRoute && !authenticated) return <Login />;
  if (route === '/kiosk') return <Kiosk onCreate={createTicket} />;
  if (route === '/confirm') return <ConfirmVisit />;
  if (route === '/ticket/general') return <YourQueue ticket={{ ticketCode: 'Q001', category: 'general' }} />;
  if (route === '/ticket/emergency') return <YourQueue ticket={{ ticketCode: 'Q001', category: 'emergency' }} />;
  if (route === '/operator' || route === '/admin-queue') return <FigmaQueue queueData={queue} actions={actions} loading={loading || actionBusy} error={error || actionError} />;
  if (route === '/dashboard') return <FigmaDashboard queueData={queue} loading={loading || actionBusy} error={error || actionError} />;
  if (route === '/report') return <FigmaReport queueData={queue} error={error || actionError} />;
  if (route === '/display') return <QueueDisplay queueData={queue} />;
  return <HomeSelector />;
}

export default App;
