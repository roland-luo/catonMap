# Licences, data sources and attribution

Everything on the map is built from open data. No Google, Apple, Bing or other proprietary map content
(imagery, 3D tiles, geometry) is used, not even as a reference.


## This repository

| What | Licence |
|---|---|
| Source code (`pipeline/`, `web/`, scripts) | [MIT](LICENSE) |
| Map imagery (published tiles), `video/`, `pipeline/style/` | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) by Dmytro Krasun, **plus the data credits below**, which must be kept with any copy |

The imagery and videos are *Produced Works* under the ODbL (see OpenStreetMap below): their own licence is
free to choose, but the OpenStreetMap notice must stay with them. AI-painted images may not be protected by
copyright everywhere; where they are, CC BY 4.0 applies.

## Credit line

Shown on the map (footer), in video mode and on every clip; use it on reposts, captions and end cards:

> Map data © OpenStreetMap contributors · Tel Aviv-Yafo Municipality · Terrain: Copernicus DEM © DLR, Airbus DS · Painted with AI

Each region lists its own credit lines in `pipeline/src/places.ts` (`credits`). Shanghai uses the same data
sources without the municipal layer:

> Map data © OpenStreetMap contributors · Shanghai · Terrain: Copernicus DEM © DLR, Airbus DS · Cel-shaded cartoon render

Chengdu · Longquanyi uses OSM + Copernicus only too, with the façade and roof textures generated for its cel
shader:

> Map data © OpenStreetMap contributors · Chengdu · Longquanyi · Terrain: Copernicus DEM © DLR, Airbus DS · Cel-shaded cartoon render · Facade textures generated with Qwen-Image 2.1 (Apache-2.0)

Those are the region's three `credits` lines in `places.ts`, joined with " · ". The textures are generated
decoration, not map content: no photographed or third-party imagery goes into them, and the geometry under them
is still OpenStreetMap (ODbL) and Copernicus DEM. The photo references in `pipeline/style/facades/README.md` set
the palette and construction only; they are never shipped and never feed a render.

## Data sources

| Source | Used for | Licence | Obligations |
|---|---|---|---|
| [OpenStreetMap](https://www.openstreetmap.org/copyright) (via the Overpass API) | ground (roads, pavements, parks, beach, coastline, water, rail, landuse), buildings outside Tel Aviv-Yafo, municipal borders, roads for the traffic animation | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) | "© OpenStreetMap contributors" visible with the map and videos. Map images and videos are Produced Works (no share-alike on them). The data the pipeline derives by joining OSM with other data is a Derivative Database: it is not redistributed, and `pipeline/` (this repository) is the published method to recreate it. |
| [Tel Aviv-Yafo Municipality GIS](https://opendatasource.tel-aviv.gov.il/) (layer 513 buildings, layer 574 tree canopy 2024) | building footprints and surveyed heights, trees in Tel Aviv-Yafo | Municipal open-data terms (the Hebrew text is binding) | Cite the source. |
| [Copernicus DEM GLO-30](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM) (AWS Open Data) | terrain height | Copernicus DEM licence: free, including commercial use | "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved". |

None of this data is in the repository: `npm run fetch` downloads it into `data/` (ignored by git).

## AI painting

Render tiles are repainted by OpenAI's image model through the Codex CLI (ChatGPT account). OpenAI's terms
assign the output rights to the user. No credit is required; the map and clips say "Painted with AI" because
social platforms ask for AI-generated content to be labelled.

The Shanghai and Chengdu regions are **not** painted with an image model: they are rendered with the in-repo
cel-shading pass (`render --style cartoon`), so their tiles and clips must not be labelled "Painted with AI";
they are credited as a cel-shaded render. The same applies to any region rendered with `--style cartoon`.
Chengdu's façade and roof textures come from Qwen-Image 2.1, which runs on those flat pattern images only: the
shader tiles and lights them, so the tiles stay a cel render, not painted map content.

`pipeline/style/reference.png` (the house style, a stretch of the painted Tel Aviv map: Gordon beach and the
city behind it), `trees.png` (tree species sheet) and `sea.png` (sea texture) were painted the same way for
this project. `pipeline/style/facades/` is the exception: its façade and roof textures are generated with
Qwen-Image 2.1 (below) and are flat-lit on purpose, because the shader adds the light.

## Software

[three.js](https://threejs.org) (MIT), [OpenSeadragon](https://openseadragon.github.io) (BSD-3-Clause),
[Astro](https://astro.build) (MIT), [sharp](https://sharp.pixelplumbing.com) (Apache-2.0),
[Playwright](https://playwright.dev) (Apache-2.0), [esbuild](https://esbuild.github.io) (MIT),
[tsx](https://tsx.is) (MIT), [FFmpeg](https://ffmpeg.org) (LGPL/GPL, used as an external tool only),
[gifsicle](https://www.lcdf.org/gifsicle/) (GPL-2.0, external tool only),
[Qwen-Image 2.1](https://github.com/QwenLM/Qwen-Image) (Apache-2.0, model weights run locally through ComfyUI).
Installed from npm or the system package manager, not vendored; their licences come with them. The Qwen-Image
weights are not in this repository either (they live in the local ComfyUI install), and its output — the façade
and roof textures in `pipeline/style/facades/` — is our own asset under this project's licence.

This is not legal advice.
