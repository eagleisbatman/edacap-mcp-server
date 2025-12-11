# EDACaP Climate Advisory MCP Server

MCP Server providing climate forecasts and agricultural advisory for Ethiopian farmers via the Aclimate/EDACaP platform.

## Overview

This MCP server provides weather and climate information for Ethiopian farmers, including:
- Weather station data
- Seasonal climate forecasts (rainfall, temperature)
- Crop yield predictions

## API Documentation

- **Main Docs**: https://docs.aclimate.org/en/latest/
- **Swagger API**: https://webapi.aclimate.org/swagger/index.html
- **R Package**: https://github.com/CIAT-DAPA/aclimaterapi
- **Python Package**: https://github.com/CIAT-DAPA/aclimatepyapi

## Supported Region

- **Ethiopia** (primary focus)

## Tools

### `get_weather_stations`

Get list of weather stations in Ethiopia.

**Parameters:** None

**Returns:** List of stations with IDs, names, and coordinates.

### `get_climate_forecast`

Get seasonal climate forecast for a location.

**Parameters:**
- `latitude` (optional): Latitude coordinate
- `longitude` (optional): Longitude coordinate
- `station_id` (optional): Weather station ID

**Returns:** Climate predictions (rainfall, temperature).

### `get_crop_forecast`

Get crop yield forecast for a location.

**Parameters:**
- `latitude` (optional): Latitude coordinate
- `longitude` (optional): Longitude coordinate
- `station_id` (optional): Weather station ID

**Returns:** Yield predictions by crop and soil type.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3002 |
| `EDACAP_API_BASE_URL` | Aclimate API URL | https://webapi.aclimate.org |
| `ALLOWED_ORIGINS` | CORS allowed origins | * |

## Local Development

```bash
npm install
npm run dev
```

## Deployment

Railway deployment is configured in `railway.json`.

## Health Check

```bash
curl http://localhost:3002/health
```

