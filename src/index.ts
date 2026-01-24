import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { EDACaPClient } from './edacap-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Middleware
app.use(express.json());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  exposedHeaders: ['Mcp-Session-Id'],
  allowedHeaders: ['Content-Type', 'mcp-session-id', 'Authorization', 'X-Farm-Latitude', 'X-Farm-Longitude']
}));

// Serve API documentation
app.use('/docs', express.static(path.join(__dirname, '../docs')));
app.use('/docs', express.static(path.join(__dirname, '../../docs')));

// Environment variables
const PORT = process.env.PORT || 3002;
const EDACAP_API_BASE_URL = process.env.EDACAP_API_BASE_URL || 'https://webapi.aclimate.org';

// Initialize EDACaP Client
const edacapClient = new EDACaPClient(EDACAP_API_BASE_URL);

// Cache Ethiopia ID to avoid repeated lookups
let cachedEthiopiaId: string | null = null;

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'edacap-mcp-server',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    supportedRegion: 'Ethiopia',
    apiDocumentation: 'https://docs.aclimate.org/en/latest/'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'EDACaP Climate Advisory MCP Server',
    version: '1.0.0',
    description: 'Climate forecasts and agricultural advisory for Ethiopian farmers via Aclimate/EDACaP',
    endpoints: {
      health: '/health',
      mcp: '/mcp (POST)'
    },
    tools: [
      'get_weather_stations',
      'get_climate_forecast',
      'get_crop_forecast'
    ],
    supportedRegion: 'Ethiopia',
    apiDocumentation: 'https://docs.aclimate.org/en/latest/'
  });
});

// Main MCP endpoint
app.post('/mcp', async (req, res) => {
  const accept = req.headers.accept || '';
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
    req.headers.accept = 'application/json, text/event-stream';
  }
  try {
    const headerLat = req.headers['x-farm-latitude'] as string;
    const headerLon = req.headers['x-farm-longitude'] as string;
    const defaultLatitude = headerLat ? parseFloat(headerLat) : undefined;
    const defaultLongitude = headerLon ? parseFloat(headerLon) : undefined;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });

    const server = new McpServer({
      name: 'edacap-climate-advisory',
      version: '1.0.0'
    });

    // Tool 1: Get weather stations
    server.tool(
      'get_weather_stations',
      'Get list of weather stations in Ethiopia. Returns station names, IDs, and locations.',
      {},
      async () => {
        try {
          if (!cachedEthiopiaId) {
            cachedEthiopiaId = await edacapClient.getEthiopiaId();
          }

          if (!cachedEthiopiaId) {
            return {
              content: [{
                type: 'text',
                text: 'Ethiopia is not available in the EDACaP system at this time.'
              }],
              isError: true
            };
          }

          const stations = await edacapClient.getWeatherStations(cachedEthiopiaId);

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                country: 'Ethiopia',
                total_stations: stations.length,
                stations: stations.map(s => ({
                  id: s.id,
                  name: s.name,
                  latitude: s.latitude,
                  longitude: s.longitude,
                  municipality: s.municipality?.name,
                  state: s.municipality?.state?.name
                }))
              }, null, 2)
            }]
          };
        } catch (error: any) {
          console.error('[MCP Tool] Error:', error);
          return {
            content: [{
              type: 'text',
              text: `Error fetching weather stations: ${error.message}`
            }],
            isError: true
          };
        }
      }
    );

    // Tool 2: Get climate forecast
    server.tool(
      'get_climate_forecast',
      'Get seasonal climate forecast for a location in Ethiopia. Returns rainfall, temperature predictions.',
      {
        latitude: z.number().min(-90).max(90).optional().describe('Latitude coordinate'),
        longitude: z.number().min(-180).max(180).optional().describe('Longitude coordinate'),
        station_id: z.string().optional().describe('Weather station ID (alternative to coordinates)')
      },
      async ({ latitude, longitude, station_id }) => {
        try {
          const lat = latitude ?? defaultLatitude;
          const lon = longitude ?? defaultLongitude;

          if (!cachedEthiopiaId) {
            cachedEthiopiaId = await edacapClient.getEthiopiaId();
          }

          if (!cachedEthiopiaId) {
            return {
              content: [{
                type: 'text',
                text: 'Ethiopia is not available in the EDACaP system at this time.'
              }],
              isError: true
            };
          }

          let stationId = station_id;
          let response;

          // If station ID provided, use it directly
          if (stationId) {
            console.log(`[MCP Tool] Using provided station ID: ${stationId}`);
            response = await edacapClient.getClimateForecast(stationId);
          }
          // Otherwise, find an active station near the coordinates
          else if (lat !== undefined && lon !== undefined) {
            // Try to find a station with actual data (tries up to 3 nearby stations)
            const activeResult = await edacapClient.findActiveStation(lat, lon, cachedEthiopiaId, 3);
            
            if (activeResult) {
              stationId = activeResult.station.id;
              response = activeResult.forecast;
              console.log(`[MCP Tool] Found active station: ${activeResult.station.name} (${stationId})`);
            } else {
              // No active station found - return helpful message
              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    message: 'No seasonal climate forecast data is currently available for your location. The EDACaP system does not have active weather stations with forecast data near your coordinates. For current weather, please use Tomorrow.io or AccuWeather instead.',
                    coordinates: { latitude: lat, longitude: lon },
                    suggestion: 'Try asking for current weather or weekly forecast instead'
                  }, null, 2)
                }]
              };
            }
          } else {
            return {
              content: [{
                type: 'text',
                text: 'Please provide coordinates or a station ID to get climate forecasts.'
              }],
              isError: true
            };
          }

          // Handle case where climate array is empty or missing (shouldn't happen with findActiveStation, but just in case)
          if (!response || !response.climate || response.climate.length === 0) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  station_id: stationId,
                  message: 'No climate forecast data available for this station at this time.',
                  forecast_id: response?.forecast,
                  confidence: response?.confidence
                }, null, 2)
              }]
            };
          }

          // Process climate data from the response
          const climateData = response.climate.map(c => ({
            weather_station: c.weather_station,
            forecasts: c.data.map(d => ({
              year: d.year,
              month: d.month,
              probabilities: d.probabilities.map(p => ({
                measure: p.measure,
                below_normal: p.lower,
                normal: p.normal,
                above_normal: p.upper
              }))
            })),
            performance: c.performance
          }));

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                station_id: stationId,
                forecast_id: response.forecast,
                confidence: response.confidence,
                climate_forecasts: climateData
              }, null, 2)
            }]
          };
        } catch (error: any) {
          console.error('[MCP Tool] Error:', error);
          return {
            content: [{
              type: 'text',
              text: `Error fetching climate forecast: ${error.message}`
            }],
            isError: true
          };
        }
      }
    );

    // Tool 3: Get crop/agronomic forecast
    server.tool(
      'get_crop_forecast',
      'Get crop yield forecast for a location in Ethiopia. Returns expected yield predictions for available crops.',
      {
        latitude: z.number().min(-90).max(90).optional().describe('Latitude coordinate'),
        longitude: z.number().min(-180).max(180).optional().describe('Longitude coordinate'),
        station_id: z.string().optional().describe('Weather station ID (alternative to coordinates)')
      },
      async ({ latitude, longitude, station_id }) => {
        try {
          const lat = latitude ?? defaultLatitude;
          const lon = longitude ?? defaultLongitude;

          if (!cachedEthiopiaId) {
            cachedEthiopiaId = await edacapClient.getEthiopiaId();
          }

          if (!cachedEthiopiaId) {
            return {
              content: [{
                type: 'text',
                text: 'Ethiopia is not available in the EDACaP system at this time.'
              }],
              isError: true
            };
          }

          let stationId = station_id;

          if (!stationId && lat !== undefined && lon !== undefined) {
            const nearestStation = await edacapClient.findNearestStation(lat, lon, cachedEthiopiaId);
            if (nearestStation) {
              stationId = nearestStation.id;
            }
          }

          if (!stationId) {
            return {
              content: [{
                type: 'text',
                text: 'Please provide coordinates or a station ID to get crop forecasts.'
              }],
              isError: true
            };
          }

          const forecasts = await edacapClient.getAgronomicForecast(stationId);

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                station_id: stationId,
                crop_forecasts: forecasts.map(f => ({
                  cultivar: f.cultivar,
                  soil: f.soil,
                  predictions: f.data.map(d => ({
                    measure: d.measure,
                    median: d.median,
                    average: d.avg,
                    range: { min: d.min, max: d.max },
                    confidence: { lower: d.conf_lower, upper: d.conf_upper }
                  }))
                }))
              }, null, 2)
            }]
          };
        } catch (error: any) {
          console.error('[MCP Tool] Error:', error);
          return {
            content: [{
              type: 'text',
              text: `Error fetching crop forecast: ${error.message}`
            }],
            isError: true
          };
        }
      }
    );

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

  } catch (error) {
    console.error('[MCP] Error:', error);
    res.status(500).json({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: 'Internal server error',
        data: error instanceof Error ? error.message : 'Unknown error'
      },
      id: null
    });
  }
});

// Start server
const HOST = '0.0.0.0';
const server = app.listen(Number(PORT), HOST, () => {
  console.log('');
  console.log('🚀 =========================================');
  console.log('   EDACaP Climate Advisory MCP Server');
  console.log('=========================================');
  console.log(`✅ Server running on ${HOST}:${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`🌦️  MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`🌍 Region: Ethiopia`);
  console.log(`📚 Docs: https://docs.aclimate.org/en/latest/`);
  console.log('=========================================');
  console.log('Tools: get_weather_stations, get_climate_forecast, get_crop_forecast');
  console.log('=========================================');
  console.log('');
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received: closing server');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('SIGINT received: closing server');
  server.close(() => process.exit(0));
});

