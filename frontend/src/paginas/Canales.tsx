// Canales: WhatsApp (líneas), plantillas y telefonía (SIP y números).
import { useState } from "react";
import CanalPlantillas from "../componentes/canal-plantillas";
import CanalTelefonia from "../componentes/canal-telefonia";
import CanalWhatsapp from "../componentes/canal-whatsapp";
import { Encabezado, Pestanas } from "../componentes/ui";

type Pestana = "whatsapp" | "plantillas" | "telefonia";

export default function Canales() {
  const [pestana, setPestana] = useState<Pestana>("whatsapp");
  return (
    <div className="pagina">
      <Encabezado titulo="Canales" descripcion="Conecta WhatsApp, administra plantillas y los números con los que llaman tus agentes." />
      <Pestanas<Pestana>
        valor={pestana}
        onCambio={setPestana}
        opciones={[
          { id: "whatsapp", texto: "WhatsApp", icono: "chat" },
          { id: "plantillas", texto: "Plantillas", icono: "description" },
          { id: "telefonia", texto: "Telefonía", icono: "call" },
        ]}
      />
      {pestana === "whatsapp" && <CanalWhatsapp />}
      {pestana === "plantillas" && <CanalPlantillas />}
      {pestana === "telefonia" && <CanalTelefonia />}
    </div>
  );
}
