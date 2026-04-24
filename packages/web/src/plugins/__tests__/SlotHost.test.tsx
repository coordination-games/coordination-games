import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearWebPluginRegistry, registerWebPlugin } from '../registry';
import { SlotHost } from '../SlotHost';
import type { SlotProps, WebToolPlugin } from '../types';

beforeEach(() => {
  clearWebPluginRegistry();
});

afterEach(() => {
  cleanup();
  clearWebPluginRegistry();
});

describe('SlotHost', () => {
  it('renders plugin components for a named slot', () => {
    const Panel = () => <div>panel-from-foo</div>;
    const plugin: WebToolPlugin = {
      id: 'foo',
      slots: { 'lobby:panel': Panel },
    };
    registerWebPlugin(plugin);

    render(<SlotHost name="lobby:panel" />);
    expect(screen.getByText('panel-from-foo')).toBeTruthy();
  });

  it('renders nothing for an unregistered slot', () => {
    const Panel = () => <div>panel-from-foo</div>;
    registerWebPlugin({
      id: 'foo',
      slots: { 'lobby:panel': Panel },
    });

    const { container } = render(<SlotHost name="game:overlay" />);
    expect(container.textContent).toBe('');
  });

  it('passes props through to slot components', () => {
    const Panel = (props: SlotProps) => (
      <div>
        lobby={props.lobbyId} game={props.game?.id}
      </div>
    );
    registerWebPlugin({
      id: 'foo',
      slots: { 'lobby:panel': Panel },
    });

    render(<SlotHost name="lobby:panel" lobbyId="L-1" game={{ id: 'G-7', name: 'CtL' }} />);
    expect(screen.getByText('lobby=L-1 game=G-7')).toBeTruthy();
  });

  it('renders multiple plugins for the same slot in registration order', () => {
    const A = () => <div data-testid="slot-item">A</div>;
    const B = () => <div data-testid="slot-item">B</div>;
    const C = () => <div data-testid="slot-item">C</div>;

    registerWebPlugin({ id: 'a', slots: { 'lobby:panel': A } });
    registerWebPlugin({ id: 'b', slots: { 'lobby:panel': B } });
    registerWebPlugin({ id: 'c', slots: { 'lobby:panel': C } });

    render(<SlotHost name="lobby:panel" />);
    const items = screen.getAllByTestId('slot-item').map((el) => el.textContent);
    expect(items).toEqual(['A', 'B', 'C']);
  });

  it('rejects duplicate plugin IDs', () => {
    const Panel = () => <div>x</div>;
    registerWebPlugin({ id: 'dupe', slots: { 'lobby:panel': Panel } });
    expect(() => registerWebPlugin({ id: 'dupe', slots: { 'game:panel': Panel } })).toThrow(
      /already registered: dupe/,
    );
  });
});
