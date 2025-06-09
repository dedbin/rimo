import React from "react";
globalThis.React = React;
import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('framer-motion', () => ({
  motion: { div: (props: any) => <div {...props} /> },
  AnimatePresence: (props: any) => <div>{props.children}</div>
}));

import { FontSizePicker } from '@/app/board/[boardId]/_components/font-size-picker';

describe('FontSizePicker', () => {
  it('opens menu and selects size', () => {
    const onChange = vi.fn();
    const { getByText, queryByText } = render(
      <FontSizePicker onChange={onChange} currentSize={24} />
    );
    const button = getByText('24');
    fireEvent.click(button);
    expect(queryByText('36')).toBeTruthy();
    const option = getByText('36');
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith(36);
    expect(queryByText('36')).toBeNull();
  });
});