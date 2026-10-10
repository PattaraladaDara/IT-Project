import { useCallback, useEffect, useRef, useState } from 'react';
import { apiConfig, apiRequest, demoQueue } from '../api.js';

export function useQueueData() {
  const [queue, setQueue] = useState(() => apiConfig.configured ? null : demoQueue());
  const [loading, setLoading] = useState(apiConfig.configured);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(apiConfig.configured ? '' : 'โหมดสาธิต · ตั้งค่า VITE_API_URL เพื่อเชื่อมต่อ API');
  const refreshInFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (!apiConfig.configured || refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    try {
      setQueue(await apiRequest('getQueue'));
      setError('');
    } catch (err) {
      setError(err.message);
      setQueue(current => current || demoQueue());
    } finally {
      setLoading(false);
      setRefreshing(false);
      refreshInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    refresh();
    if (!apiConfig.configured) return undefined;

    const timer = window.setInterval(refresh, 15000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { queue, setQueue, loading, refreshing, error, refresh };
}
