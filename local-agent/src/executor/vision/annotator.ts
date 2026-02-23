/**
 * Screenshot Annotator — Overlays visual data on screenshots for LLM analysis.
 *
 * NOTE: This file exports stubs because the `sharp` image-processing library
 * is not installed. The LLM works fine with the raw screenshot + structured
 * text context. Annotation is a bonus enhancement for a future iteration.
 *
 * To enable: install sharp (`npm install sharp` in local-agent/) and replace
 * the stub implementations with real drawing code.
 */

import { log } from '../../utils/logger';
import { PartialAXElement } from '@workflow-agent/shared';

/**
 * Overlay a coordinate grid on a screenshot.
 * Returns the input unchanged (annotation disabled — sharp not installed).
 */
export async function annotateWithGrid(
  screenshotBase64: string,
  _width: number,
  _height: number
): Promise<string> {
  log('[annotator] Grid annotation skipped (sharp not installed)');
  return screenshotBase64;
}

/**
 * Draw accessibility element bounds on a screenshot.
 * Returns the input unchanged (annotation disabled — sharp not installed).
 */
export async function annotateWithAccessibility(
  screenshotBase64: string,
  _elements: PartialAXElement[]
): Promise<string> {
  log('[annotator] Accessibility annotation skipped (sharp not installed)');
  return screenshotBase64;
}

/**
 * Highlight a specific region on a screenshot.
 * Returns the input unchanged (annotation disabled — sharp not installed).
 */
export async function annotateWithHighlight(
  screenshotBase64: string,
  _region: { x: number; y: number; w: number; h: number }
): Promise<string> {
  log('[annotator] Highlight annotation skipped (sharp not installed)');
  return screenshotBase64;
}
