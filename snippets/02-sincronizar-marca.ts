// Servidor: recibir la cola de un panel que ha estado sin conexión.
//
// Reglas:
//   - El sobre se abre con la clave privada. Durante una rotación de claves se prueban varias.
//   - El uuid de dentro del sobre tiene que coincidir con el de la marca.
//   - La hora que computa es la del panel menos el desfase medido al sincronizar.
//   - Nada se descarta en silencio: lo que no vale se guarda como evento y genera un aviso.
//   - Los PIN erróneos hacen esperar AL PANEL (backoff exponencial), nunca a una persona.
import { constants, privateDecrypt, type KeyObject } from 'node:crypto'

export interface Sobre {
  pin: string
  uuid: string
}

export function abrirSobre(claves: readonly KeyObject[], sobreB64: string): Sobre | null {
  const datos = Buffer.from(sobreB64, 'base64')
  for (const clave of claves) {
    try {
      const claro = privateDecrypt(
        { key: clave, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        datos,
      )
      const v: unknown = JSON.parse(claro.toString('utf8'))
      if (v && typeof v === 'object' && 'pin' in v && 'uuid' in v) {
        const { pin, uuid } = v as Record<string, unknown>
        if (typeof pin === 'string' && typeof uuid === 'string') return { pin, uuid }
      }
      return null
    } catch {
      // No es de esta clave: se prueba la siguiente.
    }
  }
  return null
}

// --- Reloj --------------------------------------------------------------------------------------

/** Positivo: el reloj del panel va adelantado. */
export const medirDesfase = (horaPanel: Date, horaServidor: Date) =>
  horaPanel.getTime() - horaServidor.getTime()

export const momentoEfectivo = (horaDispositivo: Date, desfaseMs: number) =>
  new Date(horaDispositivo.getTime() - desfaseMs)

// --- Anti-abuso ---------------------------------------------------------------------------------

const REGLAS = {
  fallosParaEsperar: 5,
  ventanaMin: 2,
  esperaInicialSeg: 30,
  esperaMaximaSeg: 300,
  dobleToqueMin: 1,
  desfaseAvisoMs: 2 * 60_000,
  antiguedadMaximaDias: 7,
}

const minutos = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 60_000

/** Segundos que el panel debe esperar según sus PIN erróneos recientes. */
export function esperaDelPanel(fallos: readonly Date[], ahora: Date): number {
  const recientes = fallos.filter((f) => minutos(f, ahora) < REGLAS.ventanaMin)
  if (recientes.length < REGLAS.fallosParaEsperar) return 0
  const extra = recientes.length - REGLAS.fallosParaEsperar
  const espera = Math.min(REGLAS.esperaInicialSeg * 2 ** extra, REGLAS.esperaMaximaSeg)
  const ultimo = Math.max(...recientes.map((f) => f.getTime()))
  return Math.max(0, Math.ceil((ultimo + espera * 1000 - ahora.getTime()) / 1000))
}

/** Misma persona, mismo botón, en menos de un minuto: una sola marca. */
export const esDobleToque = (
  anterior: { tipo: string; momento: Date } | null,
  nueva: { tipo: string; momento: Date },
) =>
  !!anterior &&
  anterior.tipo === nueva.tipo &&
  minutos(anterior.momento, nueva.momento) >= 0 &&
  minutos(anterior.momento, nueva.momento) < REGLAS.dobleToqueMin

// --- Decisión por marca -------------------------------------------------------------------------

export type Resultado =
  | { tipo: 'aceptada'; personaId: string; momento: Date; avisoReloj: boolean }
  | { tipo: 'rechazada'; motivo: 'sobre' | 'uuid' | 'pin' | 'fuera_de_plazo' | 'futura' }

interface MarcaRecibida {
  uuid: string
  horaDispositivo: Date
  sobre: string
}

export function decidir(
  marca: MarcaRecibida,
  ctx: {
    claves: readonly KeyObject[]
    desfaseMs: number
    ahora: Date
    registradoDesde: Date
    buscarPorPin: (pin: string) => string | null // la verificación real usa HMAC con pimienta
  },
): Resultado {
  const sobre = abrirSobre(ctx.claves, marca.sobre)
  if (!sobre) return { tipo: 'rechazada', motivo: 'sobre' }
  if (sobre.uuid !== marca.uuid) return { tipo: 'rechazada', motivo: 'uuid' }

  const momento = momentoEfectivo(marca.horaDispositivo, ctx.desfaseMs)
  if (momento > ctx.ahora) return { tipo: 'rechazada', motivo: 'futura' }
  const dias = (ctx.ahora.getTime() - momento.getTime()) / 86_400_000
  if (dias > REGLAS.antiguedadMaximaDias || momento < ctx.registradoDesde) {
    return { tipo: 'rechazada', motivo: 'fuera_de_plazo' }
  }

  const personaId = ctx.buscarPorPin(sobre.pin)
  if (!personaId) return { tipo: 'rechazada', motivo: 'pin' }

  return {
    tipo: 'aceptada',
    personaId,
    momento,
    avisoReloj: Math.abs(ctx.desfaseMs) > REGLAS.desfaseAvisoMs,
  }
}
// Quien llama inserta con `id = marca.uuid` y ON CONFLICT DO NOTHING: reenviar es inocuo.
// Las rechazadas van a una tabla de eventos del dispositivo y generan un aviso a la dirección.
