import { describe, expect, it } from 'vitest';
import { RoadSituationSchema, type RoadSituation } from '../../shared/schemas/roads.js';
import situationsFixture from './fixtures/situations-vesteralen.json' with { type: 'json' };
import { classifySituation, mapSituations, type RawSituationProps } from './situations.js';
import type { RawFeature } from './vegvesen-wfs.js';

/**
 * The clock every assertion here is made against. Fixed, because the
 * whole point of `classifySituation` is that "now" is an argument: the
 * fixture's windows sit around this instant deliberately (see
 * `fixtures/README.md`).
 */
const NOW = new Date('2026-09-13T12:00:00+02:00');

const FEATURES = situationsFixture.features as unknown as RawFeature[];

function situationById(situations: readonly RoadSituation[], id: string): RoadSituation {
    const found = situations.find((situation) => situation.id === id);
    if (!found) throw new Error(`expected situation ${id} in the mapped output`);
    return found;
}

/** A minimal props bag; each test overrides only the attributes its own case is about. */
function props(overrides: Partial<RawSituationProps> = {}): RawSituationProps {
    return {
        SITUATION_ID: 'NPRA_TEST',
        SITUATION_TYPE: 'MaintenanceWorks',
        IS_MAIN_RECORD: 1,
        SECONDARY_TYPES: null,
        ROAD_OR_CARRIAGEWAY_OR_LANE_MANAGEMENT_TYPE: null,
        SEVERITY: 'low',
        DESCRIPTION: 'Vegarbeid.',
        ROAD_NUMBER: 'E10',
        LOCATION_DESCRIPTION: null,
        START_TIME: '2026-09-01T07:00:00+02:00',
        END_TIME: '2026-09-30T18:00:00+02:00',
        LAST_UPDATE_TIME: '2026-09-13T06:00:00+02:00',
        NUM_PERIODS: 0,
        ACTIVE: 0,
        COORDINATES_FOR_DISPLAY_LATITUDE: 68.7,
        COORDINATES_FOR_DISPLAY_LONGITUDE: 15.4,
        ...overrides,
    };
}

describe('classifySituation', () => {
    it('calls a situation inside its window with no validity periods current, even though ACTIVE is 0', () => {
        // The single most important assertion in this file. `ACTIVE` is 1
        // only for a *periodic* situation inside one of its periods; 997
        // probed situations with no periods sat inside their window
        // carrying `ACTIVE: 0`, the Tjeldsundbrua wind warnings among
        // them. Reading `ACTIVE` as "happening now" hides exactly the
        // warnings this layer exists for.
        expect(classifySituation(props({ NUM_PERIODS: 0, ACTIVE: 0 }), NOW)).toBe('current');
    });

    it('calls a periodic situation inside one of its periods current', () => {
        expect(classifySituation(props({ NUM_PERIODS: 2, ACTIVE: 1 }), NOW)).toBe('current');
    });

    it("calls a periodic situation outside today's period scheduled", () => {
        expect(classifySituation(props({ NUM_PERIODS: 3, ACTIVE: 0 }), NOW)).toBe('scheduled');
    });

    it('calls a situation that has not started planned', () => {
        expect(classifySituation(props({ START_TIME: '2026-09-20T07:00:00+02:00' }), NOW)).toBe('planned');
    });

    it('calls a situation whose end has passed expired', () => {
        expect(classifySituation(props({ END_TIME: '2026-09-10T18:00:00+02:00' }), NOW)).toBe('expired');
    });

    it('treats a null end time as open-ended rather than missing', () => {
        expect(classifySituation(props({ END_TIME: null }), NOW)).toBe('current');
    });

    it('reads the flags however upstream spells them', () => {
        // A JSON attribute bag is not a place to be sure whether a flag
        // arrives as 1, "1" or true.
        expect(classifySituation(props({ NUM_PERIODS: '2', ACTIVE: '1' }), NOW)).toBe('current');
        expect(classifySituation(props({ NUM_PERIODS: '2', ACTIVE: false }), NOW)).toBe('scheduled');
    });
});

describe('mapSituations', () => {
    const situations = mapSituations(FEATURES, NOW);

    it('groups records into situations, dropping expired ones and ones beyond the planned horizon', () => {
        // 13 records, 11 situations, minus the expired one (NPRA_1006)
        // and the one starting in seven weeks (NPRA_1005).
        expect(situations).toHaveLength(9);
        expect(situations.map((situation) => situation.id)).not.toContain('NPRA_1005');
        expect(situations.map((situation) => situation.id)).not.toContain('NPRA_1006');
    });

    it('produces one situation for a main record and its consequence record', () => {
        expect(situations.filter((situation) => situation.id === 'NPRA_1001')).toHaveLength(1);
    });

    it("keeps the main record's type as the kind, not the consequence record's", () => {
        const sortlandsbrua = situationById(situations, 'NPRA_1001');

        expect(sortlandsbrua.kind).toBe('roadworks');
        expect(sortlandsbrua.rawType).toBe('MaintenanceWorks');
    });

    it('finds the main record by its flag even though it is not the first in the group', () => {
        // The fixture is ordered the way `sortBy=LAST_UPDATE_TIME D`
        // delivers it, so the consequence record -- edited two minutes
        // after its cause -- arrives first. Both multi-record groups are
        // like this; upstream's `IS_MAIN_RECORD` is what settles it.
        const order = situationsFixture.features.map((feature) => feature.properties.RECORD_ID);
        expect(order.indexOf('NPRA_1001_2')).toBeLessThan(order.indexOf('NPRA_1001_1'));
        expect(situationById(situations, 'NPRA_1001').rawType).toBe('MaintenanceWorks');
    });

    it('trusts the flag over the record type, so a cause with an unfamiliar type still wins', () => {
        // The failure this prevents: a consequence record whose
        // `SITUATION_TYPE` this app does not recognise (or that is
        // missing entirely) being promoted to "the cause" by a
        // type-membership guess, and giving the whole situation its kind.
        const records: RawFeature[] = [
            {
                geometry: null,
                properties: {
                    SITUATION_ID: 'NPRA_FLAGGED',
                    SITUATION_TYPE: null,
                    IS_MAIN_RECORD: 0,
                    SECONDARY_TYPES: 'laneClosures',
                    DESCRIPTION: 'Redusert framkommelighet.',
                    START_TIME: '2026-09-01T07:00:00+02:00',
                    END_TIME: null,
                    COORDINATES_FOR_DISPLAY_LATITUDE: 68.7,
                    COORDINATES_FOR_DISPLAY_LONGITUDE: 15.4,
                },
            },
            {
                geometry: null,
                properties: {
                    SITUATION_ID: 'NPRA_FLAGGED',
                    SITUATION_TYPE: 'Accident',
                    IS_MAIN_RECORD: 1,
                    DESCRIPTION: 'Trafikkuhell.',
                    START_TIME: '2026-09-01T07:00:00+02:00',
                    END_TIME: null,
                    COORDINATES_FOR_DISPLAY_LATITUDE: 68.7,
                    COORDINATES_FOR_DISPLAY_LONGITUDE: 15.4,
                },
            },
        ];

        const mapped = mapSituations(records, NOW);

        expect(mapped[0]?.kind).toBe('accident');
        expect(mapped[0]?.description).toBe('Trafikkuhell.');
    });

    it('falls back to the record type when no record in the group carries the flag', () => {
        // An older publication, or a query that asked for a narrower
        // `propertyName` set: the cause is still the record that is not a
        // management measure.
        const records: RawFeature[] = [
            {
                geometry: null,
                properties: {
                    SITUATION_ID: 'NPRA_UNFLAGGED',
                    SITUATION_TYPE: 'SpeedManagement',
                    SECONDARY_TYPES: 'speedRestriction',
                    START_TIME: '2026-09-01T07:00:00+02:00',
                    END_TIME: null,
                    COORDINATES_FOR_DISPLAY_LATITUDE: 68.7,
                    COORDINATES_FOR_DISPLAY_LONGITUDE: 15.4,
                },
            },
            {
                geometry: null,
                properties: {
                    SITUATION_ID: 'NPRA_UNFLAGGED',
                    SITUATION_TYPE: 'MaintenanceWorks',
                    START_TIME: '2026-09-01T07:00:00+02:00',
                    END_TIME: null,
                    COORDINATES_FOR_DISPLAY_LATITUDE: 68.7,
                    COORDINATES_FOR_DISPLAY_LONGITUDE: 15.4,
                },
            },
        ];

        expect(mapSituations(records, NOW)[0]?.kind).toBe('roadworks');
    });

    it('unions the effects of every record in the group, splitting the comma list', () => {
        const sortlandsbrua = situationById(situations, 'NPRA_1001');

        // The consequence record's `SECONDARY_TYPES` is the single string
        // `"laneClosures,narrowLanes"` -- both halves must arrive as
        // separate effects, alongside the main record's own type and the
        // management type.
        expect([...sortlandsbrua.effects].sort()).toEqual(['intermittentShortTermClosures', 'laneClosures', 'narrowLanes', 'roadMaintenance']);
        expect(sortlandsbrua.closed).toBe(false);
    });

    it('marks a situation closed when any record in the group closes the road', () => {
        const glamvika = situationById(situations, 'NPRA_1003');

        // The main record is a landslide; only the consequence record
        // says `roadClosed`.
        expect(glamvika.rawType).toBe('EnvironmentalObstruction');
        expect(glamvika.closed).toBe(true);
        expect(glamvika.effects).toContain('roadClosed');
    });

    it("turns the description's | into a line break and leaves the Norwegian text alone", () => {
        const sortlandsbrua = situationById(situations, 'NPRA_1001');

        expect(sortlandsbrua.description).toBe('Fv. 82 Sortlandsbrua: vedlikeholdsarbeid.\nManuell dirigering mellom 08:00 og 21:00.');
    });

    it('keeps a blank line the writer asked for', () => {
        const records: RawFeature[] = [
            {
                geometry: null,
                properties: {
                    SITUATION_ID: 'NPRA_BLANK',
                    SITUATION_TYPE: 'MaintenanceWorks',
                    IS_MAIN_RECORD: 1,
                    DESCRIPTION: 'Første avsnitt.||Andre avsnitt.',
                    START_TIME: '2026-09-01T07:00:00+02:00',
                    END_TIME: null,
                    COORDINATES_FOR_DISPLAY_LATITUDE: 68.7,
                    COORDINATES_FOR_DISPLAY_LONGITUDE: 15.4,
                },
            },
        ];

        // Closing the gap up would be an edit to text this app is not
        // allowed to edit.
        expect(mapSituations(records, NOW)[0]?.description).toBe('Første avsnitt.\n\nAndre avsnitt.');
    });

    it('takes the location from the attribute the layer actually has', () => {
        expect(situationById(situations, 'NPRA_1001').location).toBe('Sortlandsbrua');
    });

    it("classifies the fixture's live states the way the route will serve them", () => {
        expect(situationById(situations, 'NPRA_1002').status).toBe('current');
        expect(situationById(situations, 'NPRA_1007').status).toBe('scheduled');
        expect(situationById(situations, 'NPRA_1004').status).toBe('planned');
    });

    it('carries no line for a wind warning that does have a line geometry', () => {
        const tjeldsundbrua = situationById(situations, 'NPRA_1002');

        // It is a LineString upstream. A pin says everything its extent
        // would, and the bytes are better spent elsewhere.
        expect(tjeldsundbrua.kind).toBe('weather');
        expect(tjeldsundbrua.line).toBeNull();
    });

    it('carries a line for a closure and for roadworks', () => {
        const glamvika = situationById(situations, 'NPRA_1003');
        const sortlandsbrua = situationById(situations, 'NPRA_1001');

        // A MultiLineString becomes one entry per part.
        expect(glamvika.line).toHaveLength(2);
        expect(sortlandsbrua.line).toHaveLength(1);
    });

    it('takes the line from another record in the group when the main record has none', () => {
        // The probe found the geometry repeated byte for byte across
        // every multi-record situation, so this is belt and braces -- but
        // it costs one line and means a closure is never drawn as a bare
        // pin because the cause record happened to travel without its
        // geometry.
        const records: RawFeature[] = [
            {
                geometry: null,
                properties: {
                    SITUATION_ID: 'NPRA_SPLIT_GEOMETRY',
                    SITUATION_TYPE: 'EnvironmentalObstruction',
                    IS_MAIN_RECORD: 1,
                    START_TIME: '2026-09-01T07:00:00+02:00',
                    END_TIME: null,
                    COORDINATES_FOR_DISPLAY_LATITUDE: 68.7,
                    COORDINATES_FOR_DISPLAY_LONGITUDE: 15.4,
                },
            },
            {
                geometry: {
                    type: 'LineString',
                    coordinates: [
                        [15.4, 68.7],
                        [15.42, 68.71],
                    ],
                },
                properties: {
                    SITUATION_ID: 'NPRA_SPLIT_GEOMETRY',
                    SITUATION_TYPE: 'RoadOrCarriagewayOrLaneManagement',
                    IS_MAIN_RECORD: 0,
                    ROAD_OR_CARRIAGEWAY_OR_LANE_MANAGEMENT_TYPE: 'roadClosed',
                    START_TIME: '2026-09-01T07:00:00+02:00',
                    END_TIME: null,
                    COORDINATES_FOR_DISPLAY_LATITUDE: 68.7,
                    COORDINATES_FOR_DISPLAY_LONGITUDE: 15.4,
                },
            },
        ];

        expect(mapSituations(records, NOW)[0]?.line).toEqual([
            [
                [68.7, 15.4],
                [68.71, 15.42],
            ],
        ]);
    });

    it("swaps upstream's [lng, lat] into Leaflet's [lat, lng]", () => {
        const glamvika = situationById(situations, 'NPRA_1003');

        // Upstream's first coordinate pair is [15.01811, 68.79981].
        expect(glamvika.line?.[0]?.[0]).toEqual([68.79981, 15.01811]);
        // And the same swap on the pin, from the display attributes.
        expect(glamvika.point).toEqual({ lat: 68.80121, lng: 15.02233 });
    });

    it('simplifies a long line instead of forwarding every survey point', () => {
        const longLine = situationById(situations, 'NPRA_1010');

        expect(longLine.line?.[0]?.length).toBeLessThan(60);
    });

    it('carries no line for roadworks whose geometry is a point', () => {
        expect(situationById(situations, 'NPRA_1007').line).toBeNull();
    });

    it('maps a ferry notice and an accident onto their own kinds', () => {
        expect(situationById(situations, 'NPRA_1008').kind).toBe('ferry');
        expect(situationById(situations, 'NPRA_1009').kind).toBe('accident');
    });

    it('reads a lone consequence record as a management measure, with its nulls intact', () => {
        const lights = situationById(situations, 'NPRA_1011');

        expect(lights.kind).toBe('management');
        expect(lights.roadNumber).toBeNull();
        expect(lights.location).toBeNull();
        expect(lights.endsAt).toBeNull();
        expect(lights.effects).toEqual(['temporaryTrafficLights']);
        // No `SEVERITY` upstream: passed through as the value upstream
        // itself uses for "not known", never invented as `low`.
        expect(lights.severity).toBe('unknown');
    });

    it('stamps periodic, the window and the newest update time in the group', () => {
        const sortlandsbrua = situationById(situations, 'NPRA_1001');

        expect(sortlandsbrua.periodic).toBe(true);
        expect(sortlandsbrua.startsAt).toBe('2026-09-01T07:00:00+02:00');
        expect(sortlandsbrua.endsAt).toBe('2026-10-15T20:00:00+02:00');
        // The consequence record was updated two minutes after the main one.
        expect(sortlandsbrua.updatedAt).toBe('2026-09-13T06:14:00+02:00');
        expect(situationById(situations, 'NPRA_1002').periodic).toBe(false);
    });

    it('produces situations that satisfy the shared contract', () => {
        for (const situation of situations) {
            expect(() => RoadSituationSchema.parse(situation)).not.toThrow();
        }
    });

    it('drops a record it cannot parse or cannot place, rather than the response', () => {
        const broken: RawFeature[] = [
            { geometry: null, properties: { SITUATION_ID: 'no-start-time' } },
            { geometry: null, properties: { SITUATION_ID: 'unplaceable', START_TIME: '2026-09-01T07:00:00+02:00' } },
            ...FEATURES,
        ];

        expect(mapSituations(broken, NOW)).toHaveLength(9);
    });

    it('rejects a situation whose coordinates are outside world bounds', () => {
        // What a missed [lng, lat] swap looks like: a latitude of 168.
        const swapped: RawFeature[] = [
            {
                geometry: null,
                properties: {
                    SITUATION_ID: 'swapped',
                    SITUATION_TYPE: 'MaintenanceWorks',
                    START_TIME: '2026-09-01T07:00:00+02:00',
                    END_TIME: null,
                    COORDINATES_FOR_DISPLAY_LATITUDE: 168.7,
                    COORDINATES_FOR_DISPLAY_LONGITUDE: 15.4,
                },
            },
        ];

        expect(mapSituations(swapped, NOW)).toEqual([]);
    });
});
