# Architecture

This document is filled in incrementally as later phases land. Phase 0 only
establishes the skeleton below.

## Overview

area-overview is a reactive vanilla-TypeScript frontend (no framework) paired
with a small Node/TypeScript backend-for-frontend (BFF). The BFF proxies and
shapes data from the Laravel API at `nesthus.no` for consumption by the
frontend, and keeps upstream credentials off the client.

## BFF

_To be documented in phase 2 (the BFF server) and phase 3 (settings store)._

## Frontend

_To be documented in phase 4 (reactive core), phase 5 (app shell/design
system), and phase 6 onward (individual pages)._

## Data flow

_To be documented once live layers (phase 7) and the settings page (phase 9)
land._
