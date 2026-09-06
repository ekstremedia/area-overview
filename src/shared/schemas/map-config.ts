import { z } from 'zod';

/**
 * The response shape of `GET /api/map-config` -- a tiny bag of frontend
 * config that must come from the running server, not the build. Right
 * now it holds only the CARTO basemap API key (see `src/server/config.ts`
 * and `src/server/routes/map-config.ts`); more fields can be added here
 * as this app grows other runtime-only, client-visible settings.
 *
 * `cartoApiKey` is always present, empty string when unconfigured --
 * same convention as `ShipsResponseSchema`'s `configured: false` rather
 * than omitting the field.
 */
export const MapConfigResponseSchema = z.object({
    cartoApiKey: z.string(),
});

export type MapConfigResponse = z.infer<typeof MapConfigResponseSchema>;
