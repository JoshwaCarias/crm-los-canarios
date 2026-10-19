"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";

const LocationPicker = dynamic(
  () => import("./location-picker").then((module) => module.LocationPicker),
  { ssr: false, loading: () => <div className="map-loading">Cargando mapa…</div> },
);

type DeliverySiteFormProps = {
  customerId: string;
  action: (formData: FormData) => void | Promise<void>;
};

export function DeliverySiteForm({ customerId, action }: DeliverySiteFormProps) {
  const [address, setAddress] = useState("");
  const [municipality, setMunicipality] = useState("");
  const [department, setDepartment] = useState("");
  const googleMapsSearchUrl = useMemo(() => {
    const query = [address, municipality, department, "Guatemala"].filter(Boolean).join(", ");
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query || "Guatemala")}`;
  }, [address, municipality, department]);

  return (
    <form className="inline-form" action={action}>
      <input type="hidden" name="customerId" value={customerId} />
      <h4>Agregar obra o dirección</h4>
      <div className="form-grid">
        <label>Nombre de obra/dirección *<input name="name" required maxLength={150} placeholder="Ej. Proyecto Zona 10" /></label>
        <label>Dirección *
          <input name="address" required maxLength={500} value={address} onChange={(event) => setAddress(event.target.value)} />
        </label>
        <label>Municipio
          <input name="municipality" maxLength={100} value={municipality} onChange={(event) => setMunicipality(event.target.value)} />
        </label>
        <label>Departamento
          <input name="department" maxLength={100} value={department} onChange={(event) => setDepartment(event.target.value)} />
        </label>
        <label className="full-width">Instrucciones de entrega<textarea name="deliveryNotes" maxLength={800} rows={3} /></label>
        <div className="full-width">
          <span className="field-label">Ubicación exacta *</span>
          <LocationPicker googleMapsSearchUrl={googleMapsSearchUrl} />
        </div>
      </div>
      <button type="submit">Guardar dirección y ubicación</button>
    </form>
  );
}
