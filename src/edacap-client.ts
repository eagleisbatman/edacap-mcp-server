/**
 * EDACaP (Aclimate) API Client
 *
 * This module provides a TypeScript client for interacting with the Aclimate Web API,
 * which provides climate forecasts and agricultural advisory for Ethiopia.
 *
 * API Documentation: https://docs.aclimate.org/en/latest/04-installation.html
 * Swagger API: https://webapi.aclimate.org/swagger/index.html
 *
 * Key Features:
 * - Weather stations by country
 * - Climate forecasts (seasonal)
 * - Historical weather data
 * - Agronomic forecasts for crops
 *
 * @module edacap-client
 */

import fetch from 'node-fetch';

// Reduced from 30s to 10s for faster response
const TIMEOUT_MS = 10000;

// Cache for weather stations (they rarely change)
let stationsCache: { stations: WeatherStation[]; fetchedAt: number } | null = null;
const STATIONS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Country information from Aclimate API
 */
export interface Country {
  id: string;
  iso2: string;
  name: string;
}

/**
 * Weather station information
 */
export interface WeatherStation {
  id: string;
  ext_id: string;
  name: string;
  latitude: number;
  longitude: number;
  origin: string;
  municipality?: {
    id: string;
    name: string;
    state?: {
      id: string;
      name: string;
      country?: {
        id: string;
        name: string;
      };
    };
  };
}

/**
 * Climate forecast response from API
 */
export interface ClimateForecastResponse {
  forecast: string;
  confidence: number;
  climate: ClimateForecastData[];
  scenario: any[];
}

/**
 * Climate data for a weather station
 */
export interface ClimateForecastData {
  weather_station: string;
  performance?: Array<{
    year: number;
    month: number;
    name: string;
    value: number;
  }>;
  data: Array<{
    year: number;
    month: number;
    probabilities: Array<{
      measure: string;
      lower?: number;
      normal?: number;
      upper?: number;
    }>;
  }>;
}

/**
 * Agronomic forecast for crops
 */
export interface AgronomicForecast {
  weather_station: string;
  cultivar: string;
  soil: string;
  data: Array<{
    measure: string;
    median: number;
    avg: number;
    min: number;
    max: number;
    quar_1: number;
    quar_2: number;
    quar_3: number;
    conf_lower: number;
    conf_upper: number;
    sd: number;
    perc_5: number;
    perc_95: number;
  }>;
}

/**
 * Historical climate data
 */
export interface HistoricalClimate {
  weather_station: string;
  year: number;
  month: number;
  data: Array<{
    measure: string;
    value: number;
  }>;
}

/**
 * Client for interacting with the Aclimate (EDACaP) API
 */
export class EDACaPClient {
  private baseUrl: string;

  /**
   * Creates a new EDACaP API client
   *
   * @param baseUrl - Base URL for API (default: https://webapi.aclimate.org)
   */
  constructor(baseUrl: string = 'https://webapi.aclimate.org') {
    this.baseUrl = baseUrl;
  }

  /**
   * Make an API request with timeout
   */
  private async request<T>(endpoint: string): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    console.log(`[EDACaP API] Fetching: ${url}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'EDACaP-MCP-Server/1.0.0'
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`EDACaP API error (${response.status}): ${errorText || response.statusText}`);
      }

      return await response.json() as T;
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error('Request timeout: API took too long to respond (30s limit)');
      }
      throw error;
    }
  }

  /**
   * Get list of countries available in the system
   */
  async getCountries(): Promise<Country[]> {
    return this.request<Country[]>('/api/Geographic/Country/json');
  }

  /**
   * Get weather stations for a country (with caching)
   *
   * @param countryId - Country ID from getCountries()
   */
  async getWeatherStations(countryId: string): Promise<WeatherStation[]> {
    // Check cache first
    if (stationsCache && Date.now() - stationsCache.fetchedAt < STATIONS_CACHE_TTL) {
      console.log('[EDACaP] Using cached weather stations');
      return stationsCache.stations;
    }

    const stations = await this.request<WeatherStation[]>(`/api/Geographic/${countryId}/WeatherStations/json`);
    
    // Cache the result
    stationsCache = { stations, fetchedAt: Date.now() };
    console.log(`[EDACaP] Cached ${stations.length} weather stations`);
    
    return stations;
  }

  /**
   * Get climate forecast for weather stations
   *
   * @param weatherStationIds - Comma-separated weather station IDs
   */
  async getClimateForecast(weatherStationIds: string): Promise<ClimateForecastResponse> {
    return this.request<ClimateForecastResponse>(`/api/Forecast/Climate/${weatherStationIds}/true/json`);
  }

  /**
   * Get historical climate data
   *
   * @param weatherStationIds - Comma-separated weather station IDs
   */
  async getHistoricalClimate(weatherStationIds: string): Promise<HistoricalClimate[]> {
    return this.request<HistoricalClimate[]>(`/api/Historical/Climatology/${weatherStationIds}/json`);
  }

  /**
   * Get agronomic (yield) forecasts for crops
   *
   * @param weatherStationIds - Comma-separated weather station IDs
   */
  async getAgronomicForecast(weatherStationIds: string): Promise<AgronomicForecast[]> {
    return this.request<AgronomicForecast[]>(`/api/Forecast/Yield/${weatherStationIds}/json`);
  }

  /**
   * Find nearest weather station to given coordinates
   */
  async findNearestStation(
    lat: number,
    lon: number,
    countryId: string
  ): Promise<WeatherStation | null> {
    const stations = await this.getWeatherStations(countryId);

    if (!stations || stations.length === 0) {
      return null;
    }

    // Calculate distance using Haversine formula
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const haversine = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
      const R = 6371; // km
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };

    let nearest: WeatherStation | null = null;
    let minDistance = Infinity;

    for (const station of stations) {
      if (station.latitude && station.longitude) {
        const distance = haversine(lat, lon, station.latitude, station.longitude);
        if (distance < minDistance) {
          minDistance = distance;
          nearest = station;
        }
      }
    }

    return nearest;
  }

  /**
   * Get Ethiopia's country ID
   */
  async getEthiopiaId(): Promise<string | null> {
    const countries = await this.getCountries();
    const ethiopia = countries.find(c => 
      c.name.toLowerCase().includes('ethiopia') || c.iso2 === 'ET'
    );
    return ethiopia?.id || null;
  }
}

