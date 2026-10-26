import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no layout observer; component tests that need measurements provide
// explicit contentRect callbacks instead of depending on viewport dimensions.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

afterEach(cleanup);
