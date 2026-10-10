function durationInMinutes(start, end) {
  if (!start || !end) return null;
  return Math.max(0, (new Date(end) - new Date(start)) / 60000);
}

function average(values) {
  return values.length
    ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
    : 0;
}

function hourOf(value) {
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? null : date.getHours();
}

export function buildDashboardFallback(tickets = []) {
  const called = tickets.filter(ticket => ticket.calledAt);
  const completed = tickets.filter(ticket => ticket.status === 'completed');
  const hourly = Array.from({ length: 12 }, (_, index) => {
    const hour = index + 8;
    return {
      hour,
      users: tickets.filter(ticket => hourOf(ticket.issuedAt) === hour).length,
      averageServiceMinutes: 0
    };
  });

  return {
    total: tickets.length,
    waiting: tickets.filter(ticket => ticket.status === 'waiting').length,
    calling: tickets.filter(ticket => ticket.status === 'called').length,
    completed: completed.length,
    skipped: tickets.filter(ticket => ticket.status === 'skipped').length,
    cancelled: tickets.filter(ticket => ticket.status === 'cancelled').length,
    emergency: tickets.filter(ticket => ticket.category === 'emergency').length,
    averageWaitMinutes: average(called
      .map(ticket => durationInMinutes(ticket.issuedAt, ticket.calledAt))
      .filter(Number.isFinite)),
    averageServiceMinutes: average(completed
      .map(ticket => durationInMinutes(ticket.calledAt, ticket.completedAt))
      .filter(Number.isFinite)),
    hourly,
    stations: []
  };
}

export function buildDashboardViewModel(data, tickets = []) {
  const fallback = buildDashboardFallback(tickets);
  const source = data || fallback;
  const stationFallback = [
    {
      station: 'ผู้ป่วยทั่วไป',
      served: tickets.filter(ticket => ticket.category === 'general' && ticket.calledAt).length,
      averageServiceMinutes: 0
    },
    {
      station: 'อุบัติเหตุ',
      served: tickets.filter(ticket => ticket.category === 'emergency' && ticket.calledAt).length,
      averageServiceMinutes: 0
    }
  ];
  const stations = (source.stations?.length ? source.stations : stationFallback).slice(0, 5);
  const maxUsers = Math.max(1, ...stations.map(station => Number(station.served) || 0));
  const maxMinutes = Math.max(1, ...stations.map(station => Number(station.averageServiceMinutes) || 0));
  const bars = stations.map(station => ({
    label: station.station === 'ไม่ระบุ' ? 'ไม่ระบุช่อง' : `ช่อง ${station.station}`,
    users: Number(station.served) || 0,
    minutes: Number(station.averageServiceMinutes) || 0,
    usersHeight: Math.max(4, ((Number(station.served) || 0) / maxUsers) * 100),
    minutesHeight: Math.max(4, ((Number(station.averageServiceMinutes) || 0) / maxMinutes) * 100)
  }));
  const hourly = source.hourly?.length ? source.hourly : fallback.hourly;
  const peakMax = Math.max(1, ...hourly.map(item => Number(item.users) || 0));

  return { source, bars, hourly, peakMax };
}

export function formatDashboardUpdatedAt(value) {
  if (!value) return null;
  return new Intl.DateTimeFormat('th-TH', {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(new Date(value));
}
