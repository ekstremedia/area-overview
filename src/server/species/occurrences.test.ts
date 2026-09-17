import { describe, expect, it } from 'vitest';
import fixture from './fixtures/gbif-occurrence-search-vesteralen.json' with { type: 'json' };
import { DiscardTally } from './discards.js';
import { licenseRank, mapOccurrences, mostRestrictiveLicense, SIGHTINGS_CAP } from './occurrences.js';
import type { RawOccurrenceRecord } from './gbif.js';

const records = fixture.results as unknown as RawOccurrenceRecord[];

describe('mapOccurrences', () => {
    it('groups two nearby same-species records into one sighting, newest wins for scalar fields', () => {
        const { sightings } = mapOccurrences(records, fixture.count);

        const bluetit = sightings.find((s) => s.scientificName.startsWith('Cyanistes caeruleus') && s.count === 2);
        expect(bluetit).toBeDefined();
        // Newest record (1002, 2026-09-12) wins observedAt and vernacularName,
        // even though the older record (1001) had a non-null vernacularName.
        expect(bluetit?.observedAt).toBe('2026-09-12');
        expect(bluetit?.vernacularName).toBeNull();
    });

    it('does not group the same species at a far-away position', () => {
        const { sightings } = mapOccurrences(records, fixture.count);

        const farAway = sightings.find((s) => s.point.lat > 69);
        expect(farAway).toBeDefined();
        expect(farAway?.count).toBe(1);
    });

    it('sums individualCount across a group, contributing nothing for a record that has none', () => {
        const { sightings } = mapOccurrences(records, fixture.count);

        const bluetit = sightings.find((s) => s.count === 2);
        expect(bluetit?.individualCount).toBe(5); // 2 + 3

        const fungus = sightings.find((s) => s.scientificName.startsWith('Amanita'));
        expect(fungus?.individualCount).toBeNull(); // its one record has no individualCount at all
    });

    it('treats a non-positive individualCount (GBIF ABSENT-style 0) as "not reported", not as a real value that sinks the group', () => {
        // A record whose only individualCount is 0 (GBIF's occurrenceStatus:
        // ABSENT shape -- see gbif.ts's occurrenceStatus=PRESENT filter,
        // added defensively here too) must not make the group fail
        // SightingSchema.individualCount (`.int().positive()`) and get
        // silently discarded as `contract`.
        const zeroOnly: RawOccurrenceRecord = {
            speciesKey: 9001,
            scientificName: 'Testus zeroicus',
            kingdom: 'Animalia',
            class: 'Aves',
            eventDate: '2026-09-14',
            decimalLatitude: 61.111,
            decimalLongitude: 11.111,
            individualCount: 0,
            license: 'http://creativecommons.org/licenses/by/4.0/legalcode',
            datasetKey: 'synthetic',
        };
        const discards = new DiscardTally();

        const { sightings } = mapOccurrences([zeroOnly], 1, discards);

        expect(discards.summary().reasons.contract).toBeUndefined();
        const sighting = sightings.find((s) => s.scientificName === 'Testus zeroicus');
        expect(sighting).toBeDefined();
        expect(sighting?.individualCount).toBeNull();

        // And when the same group also has a genuinely valid count, that
        // one still counts -- only the 0 contributes nothing.
        const withRealCount: RawOccurrenceRecord = { ...zeroOnly, individualCount: 4, eventDate: '2026-09-15' };
        const { sightings: sightingsWithReal } = mapOccurrences([zeroOnly, withRealCount], 2);
        const combined = sightingsWithReal.find((s) => s.scientificName === 'Testus zeroicus');
        expect(combined?.individualCount).toBe(4);
    });

    it("falls back to an older record's coordinateUncertaintyMeters when the newest record in the group has none", () => {
        const { sightings } = mapOccurrences(records, fixture.count);

        const bluetit = sightings.find((s) => s.count === 2);
        // 1002 (newest) has none; 1001 (older) reported 50.
        expect(bluetit?.coordinateUncertaintyMeters).toBe(50);
    });

    it('resolves a licence conflict within a group to the more restrictive licence', () => {
        const { sightings } = mapOccurrences(records, fixture.count);

        const bluetit = sightings.find((s) => s.count === 2);
        // 1001 is CC BY, 1002 is CC BY-NC -- the more restrictive wins.
        expect(bluetit?.license).toContain('by-nc');
    });

    it('falls back to kingdom, then "unknown", when class is absent from a record', () => {
        const { sightings } = mapOccurrences(records, fixture.count);

        const fungus = sightings.find((s) => s.scientificName.startsWith('Amanita'));
        expect(fungus?.class).toBe('Fungi'); // its own kingdom, since `class` is absent
    });

    it('discards a record missing eventDate', () => {
        const discards = new DiscardTally();
        mapOccurrences(records, fixture.count, discards);

        expect(discards.summary().reasons.missingEventDate).toBe(1);
    });

    it('discards a record missing speciesKey', () => {
        const discards = new DiscardTally();
        mapOccurrences(records, fixture.count, discards);

        expect(discards.summary().reasons.missingSpeciesKey).toBe(1);
    });

    it('discards a record missing its own coordinate', () => {
        const discards = new DiscardTally();
        mapOccurrences(records, fixture.count, discards);

        expect(discards.summary().reasons.attributes).toBe(1);
    });

    it('reports the exact seen/dropped counts across the fixture', () => {
        const discards = new DiscardTally();
        const { sightings } = mapOccurrences(records, fixture.count, discards);

        expect(discards.total).toBe(records.length);
        expect(discards.dropped).toBe(3); // missingEventDate + missingSpeciesKey + attributes
        expect(sightings).toHaveLength(3); // two Cyanistes groups + one Amanita group
    });

    it('is not truncated when every matching record was actually fetched and the group count is under the cap', () => {
        const { truncated } = mapOccurrences(records, fixture.count);

        expect(truncated).toBe(false);
    });

    it("reports truncated when GBIF's own total exceeds what was actually fetched", () => {
        const { truncated } = mapOccurrences(records, fixture.count + 1000);

        expect(truncated).toBe(true);
    });

    it('caps the response at 400 groups, sorted newest-observedAt-first, and reports truncated', () => {
        const many: RawOccurrenceRecord[] = [];
        const baseDate = new Date('2026-01-01T00:00:00Z');
        for (let i = 0; i < SIGHTINGS_CAP + 10; i += 1) {
            const observedAt = new Date(baseDate.getTime() + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
            many.push({
                speciesKey: i, // distinct species -> distinct groups, one record each
                scientificName: `Species number ${String(i)}`,
                kingdom: 'Animalia',
                class: 'Aves',
                eventDate: observedAt,
                decimalLatitude: 60 + i * 0.01,
                decimalLongitude: 10 + i * 0.01,
                license: 'http://creativecommons.org/licenses/by/4.0/legalcode',
                datasetKey: 'synthetic',
            });
        }

        const { sightings, truncated } = mapOccurrences(many, many.length);

        expect(truncated).toBe(true);
        expect(sightings).toHaveLength(SIGHTINGS_CAP);
        // Newest first: the last-generated record (the newest date) must survive the cap.
        expect(sightings[0]?.scientificName).toBe(`Species number ${String(SIGHTINGS_CAP + 9)}`);
    });

    it("ranks an unrecognised or malformed licence string as the MOST restrictive, not the least -- a reversal here would overstate a stranger's reuse rights", () => {
        // Pinned directly (not just via mapOccurrences' live-fixture probing):
        // an unrecognised licence must outrank every known one, including the
        // most restrictive recognised licence (CC BY-NC-ND), so a malformed
        // or future/unknown licence string can never make a group look more
        // permissively licensed than it might actually be.
        expect(licenseRank('')).toBeGreaterThan(licenseRank('http://creativecommons.org/licenses/by-nc-nd/4.0/legalcode'));
        expect(licenseRank('not a real licence at all')).toBeGreaterThan(licenseRank('http://creativecommons.org/licenses/by-nc-nd/4.0/legalcode'));

        expect(mostRestrictiveLicense(['http://creativecommons.org/publicdomain/zero/1.0/legalcode', 'garbage-licence-string'])).toBe(
            'garbage-licence-string',
        );
        expect(mostRestrictiveLicense(['http://creativecommons.org/licenses/by-nc-nd/4.0/legalcode', 'garbage-licence-string'])).toBe(
            'garbage-licence-string',
        );
    });

    it('never includes recordedBy, or any field not on the shared schema, in a mapped sighting', () => {
        const { sightings } = mapOccurrences(records, fixture.count);

        for (const sighting of sightings) {
            expect(JSON.stringify(sighting)).not.toContain('recordedBy');
            expect(JSON.stringify(sighting)).not.toContain('Sonja Stavem');
            // 'Kari Fjellheim' sits on the fixture's Amanita record -- the
            // NEWEST (and only) record in its own group, unlike 'Sonja
            // Stavem' which sits on the OLDER of two records in a group
            // whose newer record supersedes every other field. This is the
            // stronger assertion: it would catch a hypothetical "spread the
            // newest record's raw fields" bug that the older-record
            // placement alone could miss.
            expect(JSON.stringify(sighting)).not.toContain('Kari Fjellheim');
        }
    });
});
