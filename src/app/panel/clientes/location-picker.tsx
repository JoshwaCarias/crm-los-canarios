"use client";

import { useEffect, useState } from "react";
import L from "leaflet";
import { MapContainer, Marker, TileLayer, useMap, useMapEvents } from "react-leaflet";

type Position = [number, number];

const guatemalaCity: Position = [14.6349, -90.5069];

const markerIcon = L.divIcon({
  className: "location-marker",
  html: "<span aria-hidden=\"true\"></span>",
  iconSize: [30, 38],
  iconAnchor: [15, 38],
});

function formatCoordinate(coordinate: number) {
  return coordinate.toFixed(6);
}

function RecenterMap({ center }: { center: Position }) {
  const map = useMap();

  useEffect(() => {
    map.setView(center, Math.max(map.getZoom(), 15));
  }, [center, map]);

  return null;
}

function MapClickHandler({ onPick }: { onPick: (position: Position) => void }) {
  useMapEvents({
    click(event) {
      onPick([event.latlng.lat, event.latlng.lng]);
    },
  });
  return null;
}

export function LocationPicker({ googleMapsSearchUrl }: { googleMapsSearchUrl: string }) {
  const [position, setPosition] = useState<Position | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const center = position ?? guatemalaCity;

  function useCurrentLocation() {
    if (!navigator.geolocation) {
      setLocationError("Este navegador no permite obtener tu ubicación actual.");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setPosition([coords.latitude, coords.longitude]);
        setLocationError(null);
      },
      () => setLocationError("No fue posible obtener tu ubicación. Selecciona el punto directamente en el mapa."),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  return (
    <div className="location-picker">
      <input type="hidden" name="latitude" value={position ? formatCoordinate(position[0]) : ""} />
      <input type="hidden" name="longitude" value={position ? formatCoordinate(position[1]) : ""} />
      <div className="map-actions">
        <a href={googleMapsSearchUrl} target="_blank" rel="noreferrer">Buscar dirección en Google Maps</a>
        <button type="button" className="map-button" onClick={useCurrentLocation}>Usar mi ubicación</button>
      </div>
      <p className="map-help">Busca la dirección si lo necesitas y luego haz clic o arrastra el pin hasta el punto exacto. El pin es obligatorio para guardar la dirección.</p>
      <MapContainer center={center} zoom={position ? 15 : 11} scrollWheelZoom className="location-map">
        <TileLayer
          attribution={'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <RecenterMap center={center} />
        <MapClickHandler onPick={setPosition} />
        {position && (
          <Marker
            position={position}
            icon={markerIcon}
            draggable
            eventHandlers={{
              dragend(event) {
                const next = event.target.getLatLng();
                setPosition([next.lat, next.lng]);
              },
            }}
          />
        )}
      </MapContainer>
      {position ? (
        <p className="coordinate-readout">Pin seleccionado: {formatCoordinate(position[0])}, {formatCoordinate(position[1])}</p>
      ) : (
        <p className="coordinate-readout">Aún no se ha seleccionado un pin.</p>
      )}
      {locationError && <p className="alert" role="alert">{locationError}</p>}
    </div>
  );
}
