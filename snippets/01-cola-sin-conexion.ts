// Cola de fichajes del panel cuando no hay red (navegador).
//
// Idea: la tablet no guarda NADA de ninguna persona. Guarda el tipo de marca, la hora de su
// reloj, un contador que solo sube y un «sobre» con {pin, uuid} cifrado con la clave PÚBLICA
// del servidor. Sin la clave privada, que solo tiene el servidor, nadie puede leer el PIN.
// El uuid de la marca será su identificador definitivo: reenviar la cola nunca duplica.

type TipoMarca = 'entrada' | 'inicio_pausa' | 'fin_pausa' | 'salida'

export interface MarcaPendiente {
  uuid: string
  tipo: TipoMarca
  horaDispositivo: string // ISO 8601
  contador: number
  sobre: string // base64
}

const BD = 'panel'
const COLA = 'cola'
const META = 'meta'

function abrirBd(): Promise<IDBDatabase> {
  return new Promise((ok, ko) => {
    const peticion = indexedDB.open(BD, 1)
    peticion.onupgradeneeded = () => {
      const bd = peticion.result
      bd.createObjectStore(COLA, { keyPath: 'uuid' })
      bd.createObjectStore(META)
    }
    peticion.onsuccess = () => ok(peticion.result)
    peticion.onerror = () => ko(peticion.error)
  })
}

async function enTienda<T>(
  tienda: string,
  modo: IDBTransactionMode,
  op: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const bd = await abrirBd()
  return new Promise<T>((ok, ko) => {
    const tx = bd.transaction(tienda, modo)
    const req = op(tx.objectStore(tienda))
    req.onsuccess = () => ok(req.result)
    req.onerror = () => ko(req.error)
    tx.oncomplete = () => bd.close()
  })
}

/** Pide al navegador que no borre la cola si le falta espacio. */
export const pedirAlmacenamientoPersistente = async () =>
  (await navigator.storage?.persist?.()) ?? false

/** Contador monótono que sobrevive a reinicios: si el servidor ve que baja, algo va mal. */
async function siguienteContador(): Promise<number> {
  const actual = (await enTienda<number | undefined>(META, 'readonly', (s) => s.get('contador'))) ?? 0
  await enTienda(META, 'readwrite', (s) => s.put(actual + 1, 'contador'))
  return actual + 1
}

/** Cifra {pin, uuid} con la clave pública del servidor (SPKI en base64, RSA-OAEP SHA-256). */
async function cerrarSobre(clavePublicaSpki: string, datos: { pin: string; uuid: string }) {
  const der = Uint8Array.from(atob(clavePublicaSpki), (c) => c.charCodeAt(0))
  const clave = await crypto.subtle.importKey(
    'spki',
    der,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  )
  const cifrado = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    clave,
    new TextEncoder().encode(JSON.stringify(datos)),
  )
  return btoa(String.fromCharCode(...new Uint8Array(cifrado)))
}

/** Lo que hace el panel al pulsar un botón sin conexión. */
export async function ficharSinConexion(pin: string, tipo: TipoMarca, clavePublica: string) {
  const uuid = crypto.randomUUID()
  const marca: MarcaPendiente = {
    uuid,
    tipo,
    horaDispositivo: new Date().toISOString(),
    contador: await siguienteContador(),
    // El uuid va DENTRO del cifrado: un sobre copiado a otra marca no sirve.
    sobre: await cerrarSobre(clavePublica, { pin, uuid }),
  }
  await enTienda(COLA, 'readwrite', (s) => s.put(marca))
  // El panel no sabe de quién es el PIN: la confirmación no lleva nombre.
  return { mensaje: 'Fichaje guardado. Se enviará en cuanto vuelva la conexión.' }
}

/** Al volver la red: envía en tandas y quita solo lo que el servidor confirma. */
export async function sincronizar(enviar: (lote: MarcaPendiente[], horaPanel: string) => Promise<string[]>) {
  const pendientes = await enTienda<MarcaPendiente[]>(COLA, 'readonly', (s) => s.getAll())
  pendientes.sort((a, b) => a.contador - b.contador)
  for (let i = 0; i < pendientes.length; i += 50) {
    const lote = pendientes.slice(i, i + 50)
    // Se envía también la hora actual del panel: con ella el servidor mide el desfase del reloj.
    const procesados = await enviar(lote, new Date().toISOString())
    for (const uuid of procesados) await enTienda(COLA, 'readwrite', (s) => s.delete(uuid))
  }
}
