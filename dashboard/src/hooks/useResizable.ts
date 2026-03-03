import { useCallback, useEffect, useRef, useState } from 'react';

const SIDEBAR_WIDTH_KEY = 'wfa-sidebar-width';

export function useResizable(initialWidth: number, minWidth: number, maxWidth: number) {
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (saved) {
      const parsed = parseInt(saved, 10);
      if (!isNaN(parsed) && parsed >= minWidth && parsed <= maxWidth) {
        // Also set the CSS variable on initial load
        document.documentElement.style.setProperty('--sidebar-width', `${parsed}px`);
        return parsed;
      }
    }
    return initialWidth;
  });
  const isDragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
    startX.current = e.clientX;
    startWidth.current = width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  }, [width]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      requestAnimationFrame(() => {
        const delta = e.clientX - startX.current;
        const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth.current + delta));
        setWidth(newWidth);
        document.documentElement.style.setProperty('--sidebar-width', `${newWidth}px`);
      });
    };

    const handleMouseUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Persist sidebar width
      const currentWidth = parseInt(
        document.documentElement.style.getPropertyValue('--sidebar-width') || `${initialWidth}`,
        10
      );
      if (!isNaN(currentWidth)) {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(currentWidth));
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [minWidth, maxWidth, initialWidth]);

  return { width, handleMouseDown };
}
