/**
 * English string table. Typed as `Record<keyof typeof nb, string>` so
 * TypeScript rejects this file the moment it's missing a key `nb.ts`
 * defines, or has one `nb.ts` doesn't -- a translation gap is a
 * `npm run typecheck` failure, not something discovered on the kiosk.
 */
import { nb } from './nb.js';

export const en: Record<keyof typeof nb, string> = {
    'brand.title': 'Området',

    'nav.map': 'Map',
    'nav.weather': 'Weather',
    'nav.aurora': 'Aurora',
    'nav.tide': 'Tide',
    'nav.cameras': 'Cameras',
    'nav.settings': 'Settings',

    'locality.map': 'Sortland · Vesterålen',
    'locality.weather': 'Sortland · Vesterålen',
    'locality.aurora': 'Sortland · Vesterålen',
    'locality.tide': 'Andenes · nearest measuring station',
    'locality.cameras': 'Two cameras',
    'locality.settings': 'Settings',

    'page.placeholderBody': 'Content arrives in a later phase.',

    'masthead.stale': 'Stale data · {duration}',
    'masthead.layerCounts': '{ships} ships · {aircraft} aircraft',

    'footer.attributionPlaceholder': 'Source coming',
    'footer.updated': 'Updated {relative}',
    'footer.nightScheduleActive': 'Night schedule active {from}–{to} · one tap lifts the veil for 30 s',

    'unit.minutes': 'min',
    'unit.seconds': 's',
    'unit.metersPerSecond': 'm/s',
    'unit.millimeters': 'mm',

    'map.unplacedLink': '{count} camera(s) without placement →',
    'map.popupClose': 'Close',
    'map.noImage': 'No image yet',
    'map.cameraImageAlt': 'Image from {name}',
    'map.openCamera': 'Open camera →',
    'map.pointForecastLabel': 'Point forecast',
    'map.pointForecastLoading': 'Loading …',
    'map.pointForecastError': 'Could not fetch the weather forecast.',
    'map.pointForecastRetry': 'Retry',
    'map.pointForecastCondition': '{condition}, {direction}',
    'map.pointForecastStats': '{wind} · {precip} · {lat} / {lng}',

    'symbol.clearsky': 'clear sky',
    'symbol.fair': 'fair',
    'symbol.partlycloudy': 'partly cloudy',
    'symbol.cloudy': 'cloudy',
    'symbol.fog': 'fog',
    'symbol.rain': 'rain',
    'symbol.lightrain': 'light rain',
    'symbol.heavyrain': 'heavy rain',
    'symbol.rainshowers': 'rain showers',
    'symbol.sleet': 'sleet',
    'symbol.snow': 'snow',
    'symbol.lightsnow': 'light snow',
    'symbol.heavysnow': 'heavy snow',

    'compass.n': 'north',
    'compass.ne': 'northeast',
    'compass.e': 'east',
    'compass.se': 'southeast',
    'compass.s': 'south',
    'compass.sw': 'southwest',
    'compass.w': 'west',
    'compass.nw': 'northwest',
};
