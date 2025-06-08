import { describe, it, expect, afterEach } from 'vitest';
import { useRenameModal } from '@/store/use-rename-modal';

// Zustand stores need to be reset between tests

describe('useRenameModal store', () => {
  afterEach(() => {
    useRenameModal.setState({ isOpen: false, values: { id: '', title: '' } });
  });

  it('opens and closes with values', () => {
    const store = useRenameModal.getState();
    store.handleOpen('1','Board');
    expect(useRenameModal.getState().isOpen).toBe(true);
    expect(useRenameModal.getState().values).toEqual({ id: '1', title: 'Board' });

    store.handleClose();
    expect(useRenameModal.getState().isOpen).toBe(false);
    expect(useRenameModal.getState().values).toEqual({ id: '', title: '' });
  });
});