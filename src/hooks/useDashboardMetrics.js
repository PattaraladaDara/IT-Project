import { useCallback, useEffect, useState } from 'react';
import { apiConfig, apiRequest } from '../api.js';

/**
 * Loads the dashboard aggregate independently from the live queue list.
 * The dashboard is intentionally polled at the same cadence as the queue
 * board so a staff member can leave it open all day.
 */
export function useDashboardMetrics() {
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(apiConfig.configured);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (!apiConfig.configured) {
      setLoading(false);
      return null;
    }

    setLoading(true);
    try {
      const nextMetrics = await apiRequest('getDashboard');
      setMetrics(nextMetrics);
      setError('');
      return nextMetrics;
    } catch (err) {
      setError(err.message || 'ไม่สามารถโหลดสถิติภาพรวมการให้บริการได้');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    if (!apiConfig.configured) return undefined;

    const timer = window.setInterval(refresh, 15000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { metrics, loading, error, refresh };
}
