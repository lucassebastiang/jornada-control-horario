// Aritmética de intervalos para el cómputo de jornada.
//
// Un intervalo es [desde, hasta) en milisegundos desde la época. Se trabaja SIEMPRE con instantes
// reales y se convierte a hora local solo en los bordes: así, un turno de noche que cruza el
// cambio de hora de octubre dura 9 horas, no 8.
//
// Con cuatro operaciones (unir, intersección, diferencia y duración) se expresa todo el cómputo:
//   trabajado  = duración(sesiones − pausas)
//   nocturno   = duración(trabajado ∩ franja 22:00–06:00 de cada día)
//   en festivo = duración(trabajado ∩ días festivos completos)
//   fuera      = duración(trabajado − ventanas de los turnos del cuadrante)

export interface Intervalo {
  desde: number
  hasta: number
}

export const iv = (desde: Date, hasta: Date): Intervalo => ({
  desde: desde.getTime(),
  hasta: hasta.getTime(),
})

/** Ordena, funde los que se tocan o se solapan y descarta los vacíos. */
export function unir(xs: readonly Intervalo[]): Intervalo[] {
  const ordenados = xs.filter((x) => x.hasta > x.desde).sort((a, b) => a.desde - b.desde)
  const out: Intervalo[] = []
  for (const x of ordenados) {
    const ultimo = out.at(-1)
    if (ultimo && x.desde <= ultimo.hasta) ultimo.hasta = Math.max(ultimo.hasta, x.hasta)
    else out.push({ ...x })
  }
  return out
}

/** Lo que está a la vez en `a` y en `b` (recorrido de dos punteros, O(n + m)). */
export function interseccion(a: readonly Intervalo[], b: readonly Intervalo[]): Intervalo[] {
  const [ua, ub] = [unir(a), unir(b)]
  const out: Intervalo[] = []
  let i = 0
  let j = 0
  while (i < ua.length && j < ub.length) {
    const desde = Math.max(ua[i]!.desde, ub[j]!.desde)
    const hasta = Math.min(ua[i]!.hasta, ub[j]!.hasta)
    if (hasta > desde) out.push({ desde, hasta })
    if (ua[i]!.hasta < ub[j]!.hasta) i++
    else j++
  }
  return out
}

/** Lo que está en `a` y no en `b`. */
export function diferencia(a: readonly Intervalo[], b: readonly Intervalo[]): Intervalo[] {
  const ub = unir(b)
  const out: Intervalo[] = []
  for (const x of unir(a)) {
    let cursor = x.desde
    for (const y of ub) {
      if (y.hasta <= cursor) continue
      if (y.desde >= x.hasta) break
      if (y.desde > cursor) out.push({ desde: cursor, hasta: y.desde })
      cursor = Math.max(cursor, y.hasta)
    }
    if (cursor < x.hasta) out.push({ desde: cursor, hasta: x.hasta })
  }
  return out
}

export const duracionMs = (xs: readonly Intervalo[]) =>
  unir(xs).reduce((s, x) => s + (x.hasta - x.desde), 0)

/** Se redondea al minuto sobre el total, nunca franja a franja (evita errores acumulados). */
export const aMinutos = (ms: number) => Math.round(ms / 60_000)

// --- Franjas de reloj local ---------------------------------------------------------------------

/**
 * `aInstante(fecha, 'HH:MM')` convierte una hora de reloj local de un día concreto en un instante
 * real (la implementación usa Intl con la zona del centro). Se inyecta para poder probar con
 * cualquier zona y con los días de cambio de hora.
 */
export type AInstante = (fechaISO: string, hora: string) => Date

const sumarDias = (fechaISO: string, n: number) => {
  const d = new Date(`${fechaISO}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * La franja diaria [desde, hasta) sobre las fechas indicadas. Si `hasta <= desde`, la franja
 * cruza medianoche (p. ej. 22:00–06:00) y termina al día siguiente.
 */
export function franjaDiaria(
  fechas: readonly string[],
  desde: string,
  hasta: string,
  aInstante: AInstante,
): Intervalo[] {
  return fechas.map((f) =>
    iv(aInstante(f, desde), aInstante(hasta <= desde ? sumarDias(f, 1) : f, hasta)),
  )
}

// --- Ejemplo ------------------------------------------------------------------------------------

/** Minutos nocturnos de una sesión con pausas. `fechas` incluye el día anterior por si acaso. */
export function minutosNocturnos(
  sesion: Intervalo,
  pausas: readonly Intervalo[],
  fechas: readonly string[],
  aInstante: AInstante,
): number {
  const trabajado = diferencia([sesion], pausas)
  const noche = franjaDiaria(fechas, '22:00', '06:00', aInstante)
  return aMinutos(duracionMs(interseccion(trabajado, noche)))
}
