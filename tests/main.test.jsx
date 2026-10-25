import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rootMocks = vi.hoisted(() => ({ render: vi.fn(), createRoot: vi.fn() }));
rootMocks.createRoot.mockReturnValue({ render: rootMocks.render });

vi.mock('react-dom/client', () => ({ createRoot: rootMocks.createRoot }));
vi.mock('../src/App.jsx', () => ({ default: () => React.createElement('div', null, 'QueueFlow') }));

describe('application bootstrap', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    rootMocks.createRoot.mockClear();
    rootMocks.render.mockClear();
  });

  it('mounts the React application into the root element', async () => {
    await import('../src/main.jsx');
    expect(rootMocks.createRoot).toHaveBeenCalledWith(document.getElementById('root'));
    expect(rootMocks.render).toHaveBeenCalledOnce();
  });
});
