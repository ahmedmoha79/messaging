from supabase import create_client, Client
import os
from datetime import datetime, timedelta
import math
from typing import List, Dict, Optional

class LocationService:
    def __init__(self, supabase_url: str, supabase_key: str):
        self.supabase: Client = create_client(supabase_url, supabase_key)
        
    async def update_user_location(
        self, 
        user_id: str, 
        latitude: float, 
        longitude: float, 
        accuracy: float = 0.0,
        is_sharing: bool = True,
        status_message: Optional[str] = None,
        battery_level: Optional[int] = None,
        device_context: Optional[Dict] = None
    ) -> Dict:
        """Update user's current location with additional context"""
        try:
            # Calculate expiration time (5 minutes from now)
            expires_at = datetime.utcnow() + timedelta(minutes=5)
            
            # Prepare update data
            update_data = {
                'latitude': latitude,
                'longitude': longitude,
                'accuracy': accuracy,
                'last_updated': datetime.utcnow().isoformat(),
                'expires_at': expires_at.isoformat(),
                'is_sharing': is_sharing,
                'is_online': True,
                'last_active': datetime.utcnow().isoformat()
            }
            
            # Add optional fields if provided
            if status_message:
                update_data['status_message'] = status_message
            if battery_level is not None:
                update_data['battery_level'] = battery_level
            if device_context:
                update_data['device_context'] = device_context

            # Upsert the location data
            result = await self.supabase.table('user_locations').upsert(
                {**update_data, 'user_id': user_id}
            ).execute()
            
            return result.data[0] if result.data else None
        except Exception as e:
            print(f"Error updating location: {str(e)}")
            return None

    async def get_friend_locations(self, user_id: str) -> List[Dict]:
        """Get locations of friends who are sharing their location"""
        try:
            # Get all active and sharing locations
            result = await self.supabase.table('user_locations').select(
                'user_id, latitude, longitude, accuracy, last_updated, status_message, battery_level, is_online'
            ).eq('is_sharing', True).eq('is_online', True).execute()
            
            # Filter out expired locations
            current_time = datetime.utcnow()
            valid_locations = [
                loc for loc in result.data
                if datetime.fromisoformat(loc['expires_at']) > current_time
            ]
            
            return valid_locations
        except Exception as e:
            print(f"Error getting friend locations: {str(e)}")
            return []

    async def get_nearby_users(
        self, 
        latitude: float, 
        longitude: float, 
        radius_km: float = 5.0
    ) -> List[Dict]:
        """Find users within specified radius who are sharing their location"""
        try:
            # Get all active and sharing locations
            result = await self.supabase.table('user_locations').select(
                'user_id, latitude, longitude, accuracy, last_updated, status_message, battery_level, is_online'
            ).eq('is_sharing', True).eq('is_online', True).execute()
            
            # Filter out expired locations and calculate distances
            current_time = datetime.utcnow()
            nearby_users = []
            
            for user in result.data:
                if datetime.fromisoformat(user['expires_at']) <= current_time:
                    continue
                    
                distance = self._calculate_distance(
                    latitude, longitude,
                    user['latitude'], user['longitude']
                )
                
                if distance <= radius_km:
                    user['distance'] = distance
                    nearby_users.append(user)
            
            # Sort by distance
            return sorted(nearby_users, key=lambda x: x['distance'])
        except Exception as e:
            print(f"Error getting nearby users: {str(e)}")
            return []

    async def create_location_memory(self, user_id: str, latitude: float, 
                                   longitude: float, memory_text: str) -> Dict:
        """Create a location-based memory"""
        try:
            data = {
                'user_id': user_id,
                'latitude': latitude,
                'longitude': longitude,
                'memory_text': memory_text,
                'created_at': datetime.utcnow().isoformat()
            }
            
            result = await self.supabase.table('location_memories').insert(data).execute()
            return result.data[0] if result.data else None
            
        except Exception as e:
            print(f"Error creating location memory: {str(e)}")
            return None

    async def get_location_memories(self, user_id: str) -> List[Dict]:
        """Get all location memories for a user"""
        try:
            result = await self.supabase.table('location_memories') \
                .select('*') \
                .eq('user_id', user_id) \
                .order('created_at', desc=True) \
                .execute()
            
            return result.data if result.data else []
            
        except Exception as e:
            print(f"Error getting location memories: {str(e)}")
            return []

    def _calculate_distance(
        self, 
        lat1: float, 
        lon1: float, 
        lat2: float, 
        lon2: float
    ) -> float:
        """Calculate distance between two points in kilometers"""
        R = 6371  # Earth's radius in kilometers
        
        lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])
        dlat = lat2 - lat1
        dlon = lon2 - lon1
        
        a = math.sin(dlat/2)**2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon/2)**2
        c = 2 * math.asin(math.sqrt(a))
        
        return R * c

    async def create_meetup(self, user_id: str, latitude: float, longitude: float,
                          title: str, description: str, scheduled_time: datetime) -> Dict:
        """Create a location-based meetup"""
        try:
            data = {
                'user_id': user_id,
                'latitude': latitude,
                'longitude': longitude,
                'title': title,
                'description': description,
                'scheduled_time': scheduled_time.isoformat(),
                'created_at': datetime.utcnow().isoformat()
            }
            
            result = await self.supabase.table('location_meetups').insert(data).execute()
            return result.data[0] if result.data else None
            
        except Exception as e:
            print(f"Error creating meetup: {str(e)}")
            return None

    async def get_nearby_meetups(self, latitude: float, longitude: float,
                               radius_km: float = 10.0) -> List[Dict]:
        """Get meetups within a certain radius"""
        try:
            result = await self.supabase.table('location_meetups') \
                .select('*') \
                .gt('scheduled_time', datetime.utcnow().isoformat()) \
                .execute()
            
            nearby_meetups = []
            for meetup in result.data:
                distance = self._calculate_distance(
                    latitude, longitude,
                    meetup['latitude'], meetup['longitude']
                )
                if distance <= radius_km:
                    nearby_meetups.append(meetup)
            
            return nearby_meetups
            
        except Exception as e:
            print(f"Error getting nearby meetups: {str(e)}")
            return []

    async def update_user_status(
        self,
        user_id: str,
        is_online: bool = True,
        status_message: Optional[str] = None,
        battery_level: Optional[int] = None
    ) -> Dict:
        """Update user's online status and additional information"""
        try:
            update_data = {
                'is_online': is_online,
                'last_active': datetime.utcnow().isoformat()
            }
            
            if status_message:
                update_data['status_message'] = status_message
            if battery_level is not None:
                update_data['battery_level'] = battery_level
            
            result = await self.supabase.table('user_locations').update(
                update_data
            ).eq('user_id', user_id).execute()
            
            return result.data[0] if result.data else None
        except Exception as e:
            print(f"Error updating user status: {str(e)}")
            return None

    async def cleanup_expired_locations(self) -> int:
        """Clean up expired location entries"""
        try:
            current_time = datetime.utcnow().isoformat()
            result = await self.supabase.table('user_locations').delete().lt(
                'expires_at', current_time
            ).execute()
            
            return len(result.data) if result.data else 0
        except Exception as e:
            print(f"Error cleaning up expired locations: {str(e)}")
            return 0 