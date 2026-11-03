# tbbgps — Project & Tech Stack Notes

Last updated: 2026-03-05

## Current Implementation Tech Stack (As Built)

- **Frontend runtime:** Single-file HTML app (`fleet-dashboard.html`)
- **Language:** Vanilla JavaScript (ES6+), inline in HTML
- **UI styling:** Custom CSS (dark theme), inline in HTML
- **Mapping:** Leaflet.js (CDN) + OpenStreetMap tiles
- **HTTP layer:** Browser `fetch` via internal `ApiClient`
- **Backend helper:** Node.js local proxy/static server (`dev-server.js`)
- **Build system:** None
- **Package manager requirement:** None for runtime (Node needed for proxy server)
- **Storage:** In-memory token + selected localStorage keys for UI/settings/cache

## Deployment Readiness Snapshot

- **Local/internal demo:** Ready
- **Public production:** Not ready yet

### Main blockers

1. Hardcoded login/password values exist in `fleet-dashboard.html` login inputs.
2. Dev proxy CORS is currently permissive (`Access-Control-Allow-Origin: *`).
3. No automated lint/test/CI quality gate detected.

## Recommended Production Stack (Practical)

- **Hosting:** VPS (not basic static shared hosting)
- **Web server:** Nginx (TLS termination + reverse proxy)
- **App process:** Node.js server managed by PM2 or systemd
- **Security baseline:**
  - Remove hardcoded credentials
  - Restrict CORS allowlist
  - Use environment-based config
  - HTTPS only

---

## Original Product/Feature Specification

PROJECT OVERVIEW
Build a real-time fleet management web UI using the GPS.AZ API (https://baku.gps.az). The dashboard must display live vehicle locations on an interactive map, track driver assignments, monitor fuel consumption, and visualize stops/movement events.
TECH STACK REQUIREMENTS

    Frontend: Vanilla JavaScript (ES6+), no frameworks
    Mapping: Leaflet.js with OpenStreetMap tiles
    Styling: Custom CSS with dark theme optimized for control rooms
    HTTP Client: Native Fetch API with proper error handling
    State Management: Pure JavaScript classes/modules
    Build Tool: None (single HTML file deployment)

API CONFIGURATION
Base URL: https://baku.gps.az
Authentication Flow:

    POST /api/v3/auth/login with {login, password} → returns {AuthId, User}
    Store AuthId as X-Auth header for all subsequent requests
    Token refresh: GET /api/v3/auth/check (401 = re-login needed)

Rate Limiting: 1 second delay between ALL requests (API rejects faster requests)
CORE FEATURES & API INTEGRATION
1. REAL-TIME VEHICLE TRACKING
Primary Endpoint: POST /api/v3/vehicles/getlastdata
Request Body:
JSON
Copy

{"vehicleIds": [1, 2, 3, ...]} // Array of vehicle IDs to track

Response Data Structure:
JSON
Copy

{
  "vehicleId": 123,
  "vehicleGuid": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "vehicleNumber": "ABC-123",
  "receiveTime": "2024-02-27T14:11:00.315Z",
  "recordTime": "2024-02-27T14:11:00.315Z",
  "state": 0, // 0=moving, 1=stopped, etc.
  "speed": 65.5,
  "course": 180, // degrees
  "latitude": 40.4093,
  "longitude": 49.8671,
  "address": "Baku, Azerbaijan",
  "geozones": [{"id": 1, "name": "Warehouse A"}]
}

UI Requirements:

    Map markers with directional arrows showing course
    Color coding by state:
        Green (#00C853) = moving (speed > 5)
        Red (#FF1744) = stopped (speed = 0)
        Yellow (#FFD600) = idling (0 < speed <= 5)
        Gray (#9E9E9E) = offline (no data > 10 min)
    Popup on click showing: vehicle number, speed, address, last update time, current geozone
    Auto-refresh every 10 seconds (respect 1s rate limit)
    Cluster markers when zoomed out (>50 vehicles)

2. VEHICLE LIST SIDEBAR
Endpoint: POST /api/v3/vehicles/find
Request Body (filter options):
JSON
Copy

{
  "vehicleId": null,
  "name": null,
  "imei": null,
  "sim": null,
  "deviceTypeId": null,
  "parentId": null, // Filter by client
  "unitId": null,   // Filter by department
  "customFields": null
}

Response Fields:

    vehicleId, name, imei, sim1, sim2
    parentName (client name)
    modelName (vehicle model)
    unitName (department)
    status (0=blocked, 1=active, etc.)
    customFields array with key-value pairs

UI Requirements:

    Searchable/filterable list
    Status indicator dot (green=active, red=blocked)
    Click to center map on vehicle
    Show driver name if assigned (fetch from assignments API)
    Fuel level indicator (if fuel sensor configured)

3. DRIVER MANAGEMENT & ASSIGNMENTS
Get All Drivers: POST /api/v3/Drivers/find
JSON
Copy

{"parentId": "client-guid-here"}

Get Driver Details: GET /api/v3/Drivers/{driverGuid}
Get Current Assignments: POST /api/v3/DriversVehiclesAssignments/GetByVehicles
JSON
Copy

{
  "Ids": [1, 2, 3], // Vehicle IDs
  "BeginTime": "2024-01-01T00:00:00Z",
  "EndTime": "2024-12-31T23:59:59Z"
}

Response:
JSON
Copy

[{
  "VehicleId": 123,
  "DriverId": "guid-here",
  "BeginTime": "2024-01-15T08:00:00Z",
  "EndTime": null, // null = currently assigned
  "CreateTime": "2024-01-15T08:00:00Z"
}]

UI Requirements:

    Driver card in sidebar showing: name, photo placeholder, license info
    Current vehicle assignment with "Assign" button
    Assignment history timeline
    Driver change notifications

4. FUEL MONITORING
Current Fuel Level: Read from getlastdata response (if fuel sensor configured in vehicle sensors)
Fuel Consumption Report: POST /api/v3/vehicles/fuelConsumption
JSON
Copy

{
  "sampling": 3600, // seconds (1 hour intervals)
  "vehicleIds": [1, 2, 3],
  "from": "2024-01-01T00:00:00Z",
  "to": "2024-01-31T23:59:59Z",
  "timezone": 4 // UTC+4 for Azerbaijan
}

Response:
JSON
Copy

[{
  "vehicleId": 123,
  "name": "Truck-001",
  "periods": [{
    "start": "2024-01-01T00:00:00Z",
    "end": "2024-01-01T01:00:00Z",
    "fuelLevelStart": 85.5, // liters
    "fuelLevelEnd": 82.3,
    "fuelConsumption": 3.2,
    "fuelConsumptionMove": 2.8 // while moving
  }]
}]

Fuel Refills/Thefts: POST /api/v3/vehicles/fuelInOut
JSON
Copy

{
  "vehicleIds": [1, 2, 3],
  "from": "2024-01-01T00:00:00Z",
  "to": "2024-01-31T23:59:59Z",
  "timezone": 4
}

Response:
JSON
Copy

[{
  "vehicleId": 123,
  "name": "Truck-001",
  "fuels": [{
    "event": 0, // 0=refill, 1=drain/theft
    "startDate": "2024-01-15T10:30:00Z",
    "endDate": "2024-01-15T10:35:00Z",
    "valueFuel": 50.0, // liters added/removed
    "fuelStart": 30.0,
    "fuelEnd": 80.0
  }]
}]

UI Requirements:

    Fuel gauge widget in vehicle details
    Consumption chart (line chart) for selected period
    Refill/drain events table with location mapping
    Alerts for rapid fuel drops (potential theft)

5. STOPS & MOVEMENT EVENTS
Endpoint: POST /api/v3/vehicles/moveStop
JSON
Copy

{
  "vehicleIds": [1, 2, 3],
  "from": "2024-01-01T00:00:00Z",
  "to": "2024-01-31T23:59:59Z",
  "timezone": 4
}

Response:
JSON
Copy

[{
  "vehicleId": 123,
  "vehicleName": "Truck-001",
  "moves": [{
    "eventId": 1,
    "eventName": "Moving",
    "start": "2024-01-15T08:00:00Z",
    "end": "2024-01-15T10:30:00Z",
    "duration": 9000, // seconds
    "mileage": 125.5 // km
  }],
  "stops": [{
    "eventId": 2,
    "eventName": "Stop",
    "start": "2024-01-15T10:30:00Z",
    "end": "2024-01-15T10:45:00Z",
    "duration": 900,
    "address": "Heydar Aliyev Ave, Baku, Azerbaijan"
  }]
}]

UI Requirements:

    Timeline visualization of moves (green) and stops (red)
    Stop details: address, duration, time of day
    Filter stops by duration (>15 min, >1 hour, etc.)
    Export stop report to CSV

6. MILEAGE & ENGINE HOURS
Endpoint: POST /api/v3/vehicles/mileageAndMotohours
JSON
Copy

{
  "sampling": 86400, // daily intervals
  "vehicleIds": [1, 2, 3],
  "from": "2024-01-01T00:00:00Z",
  "to": "2024-01-31T23:59:59Z",
  "timezone": 4
}

Response:
JSON
Copy

[{
  "vehicleId": 123,
  "name": "Truck-001",
  "periods": [{
    "start": "2024-01-01T00:00:00Z",
    "end": "2024-01-02T00:00:00Z",
    "mileage": 450.5, // km driven
    "mileageBegin": 15200.0,
    "mileageEnd": 15650.5,
    "motohours": 8.5, // engine hours
    "motohoursBegin": 1200.0,
    "motohoursEnd": 1208.5
  }]
}]

UI LAYOUT SPECIFICATIONS
plain
Copy

┌─────────────────────────────────────────────────────────────┐
│  HEADER (60px)                                               │
│  Logo | Client Selector | User Profile | Logout             │
├──────────────────┬──────────────────────────────────────────┤
│                  │                                          │
│  SIDEBAR (350px) │           MAP CONTAINER                  │
│  ─────────────   │                                          │
│  Search Bar      │    ┌─────────────────────────┐            │
│  ─────────────   │    │   Leaflet Map           │            │
│  Vehicle List    │    │   with Markers          │            │
│  [Filter Tabs]   │    │   & Routes              │            │
│  ─────────────   │    └─────────────────────────┘            │
│  Selected        │                                          │
│  Vehicle Details │  BOTTOM PANEL (collapsible, 250px)       │
│  [Driver Card]   │  ─────────────────────────────────────   │
│  [Fuel Gauge]    │  Tabs: Stops | Fuel | Mileage | Routes   │
│  [Quick Stats]   │  [Timeline/Chart/Table based on tab]     │
│                  │                                          │
└──────────────────┴──────────────────────────────────────────┘

Responsive Breakpoints:

    Desktop: Full layout (sidebar visible)
    Tablet: Sidebar collapses to drawer
    Mobile: Bottom sheet for vehicle list, full-screen map

COLOR SCHEME (Dark Theme)
css
Copy

:root {
  --bg-primary: #0F1419;       /* Main background */
  --bg-secondary: #1A1F2E;     /* Cards, sidebar */
  --bg-tertiary: #252B3D;      /* Hover states */
  --accent-primary: #00D4AA;    /* Active elements */
  --accent-secondary: #0099FF; /* Links, buttons */
  --text-primary: #FFFFFF;
  --text-secondary: #8B949E;
  --status-moving: #00C853;
  --status-stopped: #FF1744;
  --status-idle: #FFD600;
  --status-offline: #9E9E9E;
  --fuel-full: #00C853;
  --fuel-low: #FF9100;
  --fuel-critical: #FF1744;
}

JAVASCRIPT ARCHITECTURE
Class Structure:
JavaScript
Copy

// Main application controller
class FleetDashboard {
  constructor() {
    this.api = new GPSApi();
    this.map = new VehicleMap('map-container');
    this.sidebar = new VehicleSidebar();
    this.polling = new DataPoller(10000); // 10s refresh
  }
}

// API client with rate limiting
class GPSApi {
  constructor() {
    this.baseUrl = 'https://baku.gps.az';
    this.authToken = null;
    this.lastRequestTime = 0;
    this.minDelay = 1000; // 1 second between requests
  }
  
  async request(endpoint, method = 'GET', body = null) {
    // Implement rate limiting
    // Implement auth header injection
    // Implement error handling (401 = re-auth, 429 = retry)
  }
  
  async login(credentials) { /* ... */ }
  async getLastData(vehicleIds) { /* ... */ }
  async getVehicles(filter = {}) { /* ... */ }
  async getFuelConsumption(params) { /* ... */ }
  async getMoveStopEvents(params) { /* ... */ }
  async getDrivers(parentId) { /* ... */ }
  async getDriverAssignments(vehicleIds) { /* ... */ }
}

// Map visualization
class VehicleMap {
  constructor(containerId) {
    this.map = L.map(containerId).setView([40.4093, 49.8671], 13);
    this.markers = new Map(); // vehicleId -> marker
    this.routes = new Map(); // vehicleId -> polyline
  }
  
  updateMarkers(vehiclesData) {
    // Create/update markers with smooth animation
    // Rotate markers based on course
    // Update popups
  }
  
  drawRoute(vehicleId, coordinates) {
    // Draw historical route polyline
  }
  
  fitToBounds(vehicleIds) {
    // Auto-zoom to show all selected vehicles
  }
}

// Data polling with intelligent updates
class DataPoller {
  constructor(interval) {
    this.interval = interval;
    this.callbacks = [];
    this.isRunning = false;
  }
  
  start() { /* ... */ }
  stop() { /* ... */ }
  onTick(callback) { /* ... */ }
}

KEY INTERACTIONS

    Vehicle Selection:
        Click marker OR click list item → Center map, show details panel
        Multi-select with Ctrl/Cmd for fleet operations
        Shift+click to select range
    Time Range Selection:
        Presets: Today, Yesterday, Last 7 Days, Last 30 Days
        Custom range picker with timezone awareness (UTC+4)
    Driver Assignment:
        Drag-and-drop driver to vehicle
        Modal for assignment with time range
        Quick "Assign to Nearest" based on GPS proximity
    Fuel Alerts:
        Toast notifications for refills/drains
        Configurable thresholds (e.g., alert if >20L drop in <5 min)
    Geofencing:
        Visualize geozones on map (fetched from POST /api/v3/gis/find)
        Highlight when vehicle enters/exits

ERROR HANDLING & EDGE CASES

    API 401: Redirect to login modal, preserve current view state
    API 429 (Rate Limit): Exponential backoff retry (1s, 2s, 4s)
    Network Offline: Queue requests, show offline banner, sync when back
    Empty Vehicle List: Show "Add vehicles" prompt with API import option
    No GPS Data: Show "No signal" badge on vehicle card, last known location on map with timestamp

PERFORMANCE REQUIREMENTS

    Initial load: < 3 seconds for 100 vehicles
    Map marker update: 60 FPS animation
    Memory limit: < 200MB for 24h of tracking data
    API request batching: Group vehicle IDs (max 100 per request)

SECURITY NOTES

    Store auth token in memory only (no localStorage)
    Implement automatic logout on 401
    Sanitize all API responses before DOM insertion (XSS prevention)
    CORS handling for baku.gps.az domain

DELIVERABLES
Single HTML file (fleet-dashboard.html) containing:

    Complete CSS in <style> tag
    Complete JavaScript in <script> tag
    External dependencies: Leaflet CSS/JS from CDN
    Login form (modal) for initial auth
    No build step required - open in browser and use

Configuration Section (top of JS):
JavaScript
Copy

const CONFIG = {
  API_BASE_URL: 'https://baku.gps.az',
  DEFAULT_CENTER: [40.4093, 49.8671], // Baku
  DEFAULT_ZOOM: 13,
  POLL_INTERVAL: 10000,
  TIMEZONE: 4, // UTC+4 for Azerbaijan
  MAP_TILE_URL: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
};
