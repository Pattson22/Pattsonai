import { ToolDefinition } from "./index";

// Open-Meteo: free, keyless, no signup -- geocode a place name to
// coordinates, then pull current conditions for those coordinates. No
// secrets to configure, unlike most weather APIs.
const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

// WMO weather interpretation codes, the scheme Open-Meteo reports under
// `weather_code` -- collapsed to the handful of plain-English conditions a
// spoken or texted reply actually needs.
const WMO_CONDITIONS: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "depositing rime fog",
  51: "light drizzle",
  53: "moderate drizzle",
  55: "dense drizzle",
  56: "freezing drizzle",
  57: "freezing drizzle",
  61: "slight rain",
  63: "moderate rain",
  65: "heavy rain",
  66: "freezing rain",
  67: "freezing rain",
  71: "slight snow",
  73: "moderate snow",
  75: "heavy snow",
  77: "snow grains",
  80: "slight rain showers",
  81: "moderate rain showers",
  82: "violent rain showers",
  85: "slight snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with hail",
  99: "thunderstorm with heavy hail",
};

interface GeocodeResult {
  latitude: number;
  longitude: number;
  name: string;
  country?: string;
}

const getWeather: ToolDefinition = {
  name: "get_weather",
  description:
    "Get current weather conditions for a place. Give a city/place name, not coordinates -- it's " +
    "geocoded automatically.",
  input_schema: {
    type: "object",
    properties: {
      location: { type: "string", description: "City or place name, e.g. 'London' or 'Austin, Texas'." },
    },
    required: ["location"],
  },
  handler: async (input) => {
    const location = input.location;
    if (typeof location !== "string" || location.trim().length === 0) {
      throw new Error("Missing required 'location' field");
    }

    const geocodeRes = await fetch(
      `${GEOCODE_URL}?name=${encodeURIComponent(location.trim())}&count=1&language=en&format=json`
    );
    if (!geocodeRes.ok) throw new Error(`Geocoding request failed: ${geocodeRes.status}`);
    const geocodeData = (await geocodeRes.json()) as { results?: GeocodeResult[] };
    const place = geocodeData.results?.[0];
    if (!place) throw new Error(`Could not find a location matching "${location.trim()}"`);

    const forecastRes = await fetch(
      `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}` +
        "&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code" +
        "&temperature_unit=celsius&wind_speed_unit=kmh&timezone=auto"
    );
    if (!forecastRes.ok) throw new Error(`Forecast request failed: ${forecastRes.status}`);
    const forecastData = (await forecastRes.json()) as {
      current: {
        time: string;
        temperature_2m: number;
        apparent_temperature: number;
        relative_humidity_2m: number;
        wind_speed_10m: number;
        weather_code: number;
      };
    };
    const c = forecastData.current;

    return {
      location: place.name,
      country: place.country ?? null,
      as_of: c.time,
      condition: WMO_CONDITIONS[c.weather_code] ?? "unknown",
      temperature_c: c.temperature_2m,
      feels_like_c: c.apparent_temperature,
      humidity_pct: c.relative_humidity_2m,
      wind_kph: c.wind_speed_10m,
    };
  },
};

export const weatherTools: ToolDefinition[] = [getWeather];
