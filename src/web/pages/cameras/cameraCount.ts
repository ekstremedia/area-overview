/**
 * The masthead locality caption for the cameras route is the camera
 * count in words, up to ten (artboard 05: "To kameraer" for the real
 * deployment's two cameras) -- computed from the live camera list, never
 * hardcoded, so it stays correct if a camera is added or removed.
 */
import { t, type ParamlessKey } from '../../i18n/index.js';

const COUNT_KEYS: readonly ParamlessKey[] = [
    'cameras.count.0',
    'cameras.count.1',
    'cameras.count.2',
    'cameras.count.3',
    'cameras.count.4',
    'cameras.count.5',
    'cameras.count.6',
    'cameras.count.7',
    'cameras.count.8',
    'cameras.count.9',
    'cameras.count.10',
];

export function cameraCountLabel(count: number): string {
    const key = COUNT_KEYS[count];
    if (key !== undefined) return t(key);
    return t('cameras.count.many', { count });
}
