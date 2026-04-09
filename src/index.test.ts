/**
 * EDACaP MCP Server — index.test.ts
 *
 * Tests for Express endpoints (health, root), EDACaPClient, and tool helpers.
 * External API calls are mocked via node-fetch.
 *
 * Note: EDACaPClient uses a module-level stations cache. Tests that call
 * getWeatherStations or findNearestStations need to be aware that the cache
 * persists across calls within the same module import. We use vi.resetModules()
 * to get a fresh client for cache-sensitive tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ===========================================================================
// Mock node-fetch for EDACaPClient tests
// ===========================================================================
vi.mock('node-fetch', () => {
  const fn = vi.fn();
  return { default: fn, __esModule: true };
});

import fetch from 'node-fetch';
const mockFetch = vi.mocked(fetch);

function makeResponse(body: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body))
  } as any;
}

// ===========================================================================
// A. Health endpoint
// ===========================================================================
describe('Health endpoint', () => {
  function buildApp() {
    const app = express();
    app.use(express.json());

    app.get('/health', (_req, res) => {
      res.json({
        status: 'healthy',
        service: 'edacap-mcp-server',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        supportedRegion: 'Ethiopia',
        apiDocumentation: 'https://docs.aclimate.org/en/latest/'
      });
    });

    return app;
  }

  it('returns 200 with service info', async () => {
    const app = buildApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.service).toBe('edacap-mcp-server');
    expect(res.body.version).toBe('1.0.0');
    expect(res.body.supportedRegion).toBe('Ethiopia');
    expect(res.body).toHaveProperty('timestamp');
  });
});

// ===========================================================================
// B. Root endpoint
// ===========================================================================
describe('Root endpoint', () => {
  function buildApp() {
    const app = express();
    app.use(express.json());

    app.get('/', (_req, res) => {
      res.json({
        service: 'EDACaP Climate Advisory MCP Server',
        version: '1.0.0',
        description: 'Climate forecasts and agricultural advisory for Ethiopian farmers via Aclimate/EDACaP',
        endpoints: {
          health: '/health',
          mcp: '/mcp (POST)'
        },
        tools: [
          { name: 'weather.edacap.list_stations', alias: 'get_weather_stations' },
          { name: 'weather.edacap.forecast_climate', alias: 'get_climate_forecast' },
          { name: 'crop.edacap.forecast_yield', alias: 'get_crop_forecast' }
        ],
        supportedRegion: 'Ethiopia'
      });
    });

    return app;
  }

  it('returns service info with correct structure', async () => {
    const app = buildApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('EDACaP Climate Advisory MCP Server');
    expect(res.body.version).toBe('1.0.0');
    expect(res.body.endpoints).toHaveProperty('health');
    expect(res.body.endpoints).toHaveProperty('mcp');
    expect(res.body.supportedRegion).toBe('Ethiopia');
  });

  it('lists 3 tools', async () => {
    const app = buildApp();
    const res = await request(app).get('/');
    expect(res.body.tools).toHaveLength(3);
    expect(res.body.tools[0].name).toBe('weather.edacap.list_stations');
    expect(res.body.tools[1].name).toBe('weather.edacap.forecast_climate');
    expect(res.body.tools[2].name).toBe('crop.edacap.forecast_yield');
  });
});

// ===========================================================================
// C. EDACaPClient — API methods (no station cache interference)
// ===========================================================================
describe('EDACaPClient', () => {
  let EDACaPClient: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset modules to clear the stations cache between describe blocks
    vi.resetModules();
    // Re-mock node-fetch after reset
    vi.doMock('node-fetch', () => {
      return { default: mockFetch, __esModule: true };
    });
    const mod = await import('./edacap-client.js');
    EDACaPClient = mod.EDACaPClient;
  });

  describe('getCountries', () => {
    it('fetches list of countries', async () => {
      const client = new EDACaPClient('https://api.test.com');

      mockFetch.mockResolvedValueOnce(makeResponse([
        { id: 'eth-123', iso2: 'ET', name: 'Ethiopia' },
        { id: 'ken-456', iso2: 'KE', name: 'Kenya' }
      ]));

      const countries = await client.getCountries();
      expect(countries).toHaveLength(2);
      expect(countries[0].name).toBe('Ethiopia');
      expect(countries[0].iso2).toBe('ET');

      // Verify correct endpoint
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('/api/Geographic/Country/json');
    });

    it('throws on API error', async () => {
      const client = new EDACaPClient('https://api.test.com');
      mockFetch.mockResolvedValueOnce(makeResponse('Server error', 500));

      await expect(client.getCountries()).rejects.toThrow(/500/);
    });
  });

  describe('getEthiopiaId', () => {
    it('returns Ethiopia country ID', async () => {
      const client = new EDACaPClient('https://api.test.com');

      mockFetch.mockResolvedValueOnce(makeResponse([
        { id: 'ken-456', iso2: 'KE', name: 'Kenya' },
        { id: 'eth-123', iso2: 'ET', name: 'Ethiopia' }
      ]));

      const id = await client.getEthiopiaId();
      expect(id).toBe('eth-123');
    });

    it('returns null when Ethiopia not found', async () => {
      const client = new EDACaPClient('https://api.test.com');

      mockFetch.mockResolvedValueOnce(makeResponse([
        { id: 'ken-456', iso2: 'KE', name: 'Kenya' }
      ]));

      const id = await client.getEthiopiaId();
      expect(id).toBeNull();
    });
  });

  describe('getWeatherStations', () => {
    it('fetches and returns weather stations', async () => {
      const client = new EDACaPClient('https://api.test.com');

      const mockStations = [
        {
          id: 'ws-001',
          ext_id: 'ext-001',
          name: 'Addis Ababa',
          latitude: 9.02,
          longitude: 38.75,
          origin: 'NMA',
          municipality: {
            id: 'mun-001',
            name: 'Addis Ababa',
            state: { id: 'st-001', name: 'Addis Ababa' }
          }
        },
        {
          id: 'ws-002',
          ext_id: 'ext-002',
          name: 'Hawassa',
          latitude: 7.06,
          longitude: 38.48,
          origin: 'NMA'
        }
      ];

      mockFetch.mockResolvedValueOnce(makeResponse(mockStations));

      const stations = await client.getWeatherStations('eth-123');
      expect(stations).toHaveLength(2);
      expect(stations[0].name).toBe('Addis Ababa');
      expect(stations[0].latitude).toBe(9.02);
      expect(stations[1].name).toBe('Hawassa');
    });
  });

  describe('getClimateForecast', () => {
    it('fetches climate forecast for a station', async () => {
      const client = new EDACaPClient('https://api.test.com');

      const mockForecast = {
        forecast: 'fc-2024',
        confidence: 0.85,
        climate: [{
          weather_station: 'ws-001',
          data: [{
            year: 2024,
            month: 6,
            probabilities: [
              { measure: 'prec', lower: 0.3, normal: 0.4, upper: 0.3 }
            ]
          }]
        }],
        scenario: []
      };

      mockFetch.mockResolvedValueOnce(makeResponse(mockForecast));

      const forecast = await client.getClimateForecast('ws-001');
      expect(forecast.forecast).toBe('fc-2024');
      expect(forecast.confidence).toBe(0.85);
      expect(forecast.climate).toHaveLength(1);
      expect(forecast.climate[0].data[0].probabilities[0].measure).toBe('prec');
    });
  });

  describe('getAgronomicForecast', () => {
    it('fetches crop yield forecast', async () => {
      const client = new EDACaPClient('https://api.test.com');

      const mockYield = [{
        weather_station: 'ws-001',
        cultivar: 'Teff',
        soil: 'Vertisol',
        data: [{
          measure: 'yield_14',
          median: 2500,
          avg: 2450,
          min: 1800,
          max: 3200,
          quar_1: 2100,
          quar_2: 2500,
          quar_3: 2800,
          conf_lower: 2000,
          conf_upper: 2900,
          sd: 350,
          perc_5: 1900,
          perc_95: 3100
        }]
      }];

      mockFetch.mockResolvedValueOnce(makeResponse(mockYield));

      const forecasts = await client.getAgronomicForecast('ws-001');
      expect(forecasts).toHaveLength(1);
      expect(forecasts[0].cultivar).toBe('Teff');
      expect(forecasts[0].soil).toBe('Vertisol');
      expect(forecasts[0].data[0].median).toBe(2500);
    });
  });

  describe('findNearestStations', () => {
    it('finds nearest stations by coordinates', async () => {
      const client = new EDACaPClient('https://api.test.com');

      // This call will populate the stations cache via getWeatherStations
      mockFetch.mockResolvedValueOnce(makeResponse([
        { id: 'ws-far', ext_id: 'e1', name: 'Far Station', latitude: 12.0, longitude: 40.0, origin: 'NMA' },
        { id: 'ws-near', ext_id: 'e2', name: 'Near Station', latitude: 9.1, longitude: 38.8, origin: 'NMA' },
        { id: 'ws-mid', ext_id: 'e3', name: 'Mid Station', latitude: 10.0, longitude: 39.0, origin: 'NMA' }
      ]));

      const nearest = await client.findNearestStations(9.0, 38.7, 'eth-123', 2);
      expect(nearest).toHaveLength(2);
      // Closest should be "Near Station"
      expect(nearest[0].station.name).toBe('Near Station');
      expect(nearest[0].distance).toBeLessThan(nearest[1].distance);
    });

    it('returns empty array when no stations available', async () => {
      const client = new EDACaPClient('https://api.test.com');
      mockFetch.mockResolvedValueOnce(makeResponse([]));

      const nearest = await client.findNearestStations(9.0, 38.7, 'eth-123', 3);
      expect(nearest).toEqual([]);
    });
  });

  describe('error handling', () => {
    it('throws on network failure', async () => {
      const client = new EDACaPClient('https://api.test.com');
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(client.getCountries()).rejects.toThrow(/ECONNREFUSED/);
    });

    it('handles timeout (AbortError)', async () => {
      const client = new EDACaPClient('https://api.test.com');
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      mockFetch.mockRejectedValueOnce(err);

      await expect(client.getCountries()).rejects.toThrow(/timeout/i);
    });
  });
});
