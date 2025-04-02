import asyncio
import json
import time
from datetime import datetime, timedelta
from typing import List, Dict, Optional

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import pytz
import supabase
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from geopy.distance import geodesic
from scipy.interpolate import griddata
from scipy.ndimage import gaussian_filter

# Configuration
CONFIG = {
    "supabase_url": "https://twsqvdxhsfvdibhpfvqr.supabase.co",
    "supabase_key": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR3c3F2ZHhoc2Z2ZGliaHBmdnFyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDAxNDA2MzUsImV4cCI6MjA1NTcxNjYzNX0.EVjqobvn9fAd4djsBfg1zOlA2CVSeYukmsc_DMhT1b4",
    "heatmap_resolution": 100,  # Grid points per dimension
    "heatmap_smoothing": 1.5,   # Gaussian smoothing sigma
    "activity_window_hours": 24, # Time window for activity analysis
    "update_interval_seconds": 30,
}

app = FastAPI(title="Location Visualizer")

# CORS Configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize Supabase client
sb_client = supabase.create_client(CONFIG["supabase_url"], CONFIG["supabase_key"])

class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)

    async def broadcast(self, message: str):
        for connection in self.active_connections:
            await connection.send_text(message)

manager = ConnectionManager()

# Utility Functions
def haversine_distance(coord1, coord2):
    """Calculate the Haversine distance between two coordinates in km"""
    return geodesic(coord1, coord2).kilometers

def generate_grid(locations, resolution=100):
    """Generate a grid covering all locations"""
    lats = [loc['latitude'] for loc in locations]
    lons = [loc['longitude'] for loc in locations]
    
    grid_x = np.linspace(min(lons), max(lons), resolution)
    grid_y = np.linspace(min(lats), max(lats), resolution)
    grid_x, grid_y = np.meshgrid(grid_x, grid_y)
    return grid_x, grid_y

def calculate_density(locations, grid_x, grid_y):
    """Calculate kernel density estimate on the grid"""
    points = np.array([[loc['longitude'], loc['latitude']] for loc in locations])
    values = np.ones(len(points))
    
    # Create grid and interpolate
    grid_z = griddata(
        points, values, (grid_x, grid_y), 
        method='linear', fill_value=0
    )
    
    # Apply Gaussian smoothing
    return gaussian_filter(grid_z, sigma=CONFIG["heatmap_smoothing"])

# Data Processing Functions
async def fetch_recent_locations(hours: int = 24) -> List[Dict]:
    """Fetch recent locations from Supabase"""
    time_threshold = datetime.now(pytz.utc) - timedelta(hours=hours)
    response = sb_client.table('user_locations') \
        .select('*') \
        .gt('last_updated', time_threshold.isoformat()) \
        .execute()
    
    return response.data

async def fetch_active_users() -> List[Dict]:
    """Fetch currently active users"""
    time_threshold = datetime.now(pytz.utc) - timedelta(minutes=5)
    response = sb_client.table('users') \
        .select('id, name, status, lastonline, device_type') \
        .gt('lastonline', time_threshold.isoformat()) \
        .execute()
    
    return response.data

async def fetch_user_path(user_id: str, hours: int = 24) -> List[Dict]:
    """Fetch a user's path over time"""
    time_threshold = datetime.now(pytz.utc) - timedelta(hours=hours)
    response = sb_client.table('user_locations') \
        .select('latitude, longitude, last_updated') \
        .eq('user_id', user_id) \
        .gt('last_updated', time_threshold.isoformat()) \
        .order('last_updated') \
        .execute()
    
    return response.data

# Visualization Functions
def create_heatmap_figure(locations: List[Dict]) -> go.Figure:
    """Create a Plotly heatmap figure from location data"""
    if not locations:
        return go.Figure()
    
    grid_x, grid_y = generate_grid(locations, CONFIG["heatmap_resolution"])
    density = calculate_density(locations, grid_x, grid_y)
    
    fig = go.Figure(go.Heatmap(
        x=grid_x[0,:],
        y=grid_y[:,0],
        z=density,
        colorscale='Viridis',
        opacity=0.7,
        hoverinfo='none'
    ))
    
    # Add user locations as scatter points
    user_df = pd.DataFrame(locations)
    user_counts = user_df.groupby(['user_id', 'latitude', 'longitude']).size().reset_index(name='count')
    
    fig.add_trace(go.Scattermapbox(
        lat=user_counts['latitude'],
        lon=user_counts['longitude'],
        mode='markers',
        marker=dict(
            size=user_counts['count']*2,
            color='red',
            opacity=0.8
        ),
        text=user_counts['user_id'],
        hoverinfo='text'
    ))
    
    fig.update_layout(
        mapbox_style="open-street-map",
        mapbox=dict(
            center=dict(
                lat=np.mean([loc['latitude'] for loc in locations]),
                lon=np.mean([loc['longitude'] for loc in locations])
            ),
            zoom=10
        ),
        margin={"r":0,"t":0,"l":0,"b":0}
    )
    
    return fig

def create_user_path_figure(user_id: str, path_data: List[Dict]) -> go.Figure:
    """Create a figure showing a user's path"""
    if not path_data:
        return go.Figure()
    
    path_df = pd.DataFrame(path_data)
    path_df['time'] = pd.to_datetime(path_df['last_updated'])
    
    fig = go.Figure(go.Scattermapbox(
        lat=path_df['latitude'],
        lon=path_df['longitude'],
        mode='lines+markers',
        line=dict(width=3, color='blue'),
        marker=dict(size=8, color='red'),
        text=path_df['time'].dt.strftime('%Y-%m-%d %H:%M'),
        hoverinfo='text'
    ))
    
    fig.update_layout(
        mapbox_style="open-street-map",
        mapbox=dict(
            center=dict(
                lat=path_df['latitude'].mean(),
                lon=path_df['longitude'].mean()
            ),
            zoom=12
        ),
        margin={"r":0,"t":0,"l":0,"b":0},
        title=f"User {user_id} Path"
    )
    
    return fig

# API Endpoints
@app.get("/api/heatmap")
async def get_heatmap():
    """Get heatmap data for recent activity"""
    locations = await fetch_recent_locations(CONFIG["activity_window_hours"])
    fig = create_heatmap_figure(locations)
    return JSONResponse(content=fig.to_dict())

@app.get("/api/users/active")
async def get_active_users():
    """Get list of currently active users"""
    users = await fetch_active_users()
    return JSONResponse(content=users)

@app.get("/api/user/{user_id}/path")
async def get_user_path(user_id: str):
    """Get a user's recent path"""
    path_data = await fetch_user_path(user_id, CONFIG["activity_window_hours"])
    fig = create_user_path_figure(user_id, path_data)
    return JSONResponse(content=fig.to_dict())

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for real-time updates"""
    await manager.connect(websocket)
    try:
        while True:
            # Send periodic updates
            locations = await fetch_recent_locations(1)  # Last hour
            active_users = await fetch_active_users()
            
            update_data = {
                "locations": locations,
                "active_users": active_users,
                "timestamp": datetime.now(pytz.utc).isoformat()
            }
            
            await websocket.send_json(update_data)
            await asyncio.sleep(CONFIG["update_interval_seconds"])
            
    except WebSocketDisconnect:
        manager.disconnect(websocket)

@app.on_event("startup")
async def startup_event():
    """Initialize background tasks on startup"""
    # Could add background tasks here if needed
    pass

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)