import React from "react";
globalThis.React = React;
import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ColorPicker } from '@/app/board/[boardId]/_components/color-picker';


describe('ColorPicker', () => {
  it('renders eight color buttons and handles clicks', () => {
    const onChange = vi.fn();
    const { container } = render(<ColorPicker onChange={onChange} />);
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(8);
    fireEvent.click(buttons[3]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});