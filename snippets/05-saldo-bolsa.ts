// Saldo de la bolsa de horas: se CALCULA, no se almacena.
//
// Solo se guardan las decisiones de una persona (ajustes, regularizaciones, cierres). El resto
// se deriva de los días ya computados. Ventajas:
//   - Si se corrige un fichaje de hace dos semanas, el saldo se actualiza solo.
//   - No hay un «saldo» que pueda desincronizarse del registro.
//   - Un periodo CERRADO no se recalcula: si algo cambia después, la diferencia entra en el
//     periodo abierto como «corrección de periodos cerrados». La foto del cierre no se toca.
//
// Dos bases posibles, según la política configurada por RRHH:
//   - 'cuadrante': desviación sobre lo planificado (extra autorizado a bolsa y, si se configura,
//     lo que falta de cada día).
//   - 'contrato':  lo computado del periodo frente a la jornada pactada.

export type Base = 'cuadrante' | 'contrato'

export interface Politica {
  base: Base
  restaDefectos: boolean
  topePositivo: number | null
  topeNegativo: number | null
}

export interface Dia {
  cerrado: boolean // un día en curso todavía no cuenta
  trabajados: number
  teoricos: number
  extraAutorizado: number
  destinoExtra: 'bolsa' | 'pago' | null
  ausenciaQueComputa: number // p. ej. formación: cuenta como trabajo
  ausenciaQueConsume: number // p. ej. compensación: se descuenta de la bolsa
}

export interface Movimiento {
  minutos: number
  concepto: 'ajuste' | 'regularizacion' | 'cierre' | 'importado'
}

export function saldo(
  politica: Politica,
  dias: readonly Dia[],
  movimientos: readonly Movimiento[],
  opciones: { pactados?: number; correccionCerrados?: number } = {},
) {
  const cerrados = dias.filter((d) => d.cerrado)
  const sumar = (f: (d: Dia) => number) => cerrados.reduce((s, d) => s + f(d), 0)

  const extras = sumar((d) => (d.destinoExtra === 'bolsa' ? d.extraAutorizado : 0))

  // Lo que falta se mide SIN el extra: si no, un extra autorizado taparía un día incompleto.
  const defectos =
    politica.base === 'cuadrante' && politica.restaDefectos
      ? sumar((d) => Math.min(0, d.trabajados - d.extraAutorizado - d.teoricos))
      : 0

  // Base contrato: lo pagado aparte no es bolsa. Lo compensado se suma aquí como hecho y se
  // resta abajo como ausencia, para no restarlo dos veces.
  const computado =
    politica.base === 'contrato'
      ? sumar(
          (d) =>
            d.trabajados -
            (d.destinoExtra === 'pago' ? d.extraAutorizado : 0) +
            d.ausenciaQueComputa +
            d.ausenciaQueConsume,
        )
      : 0

  const ausencias = -sumar((d) => d.ausenciaQueConsume)
  const decisiones = movimientos.reduce((s, m) => s + m.minutos, 0)
  const correccion = opciones.correccionCerrados ?? 0

  const minutos =
    politica.base === 'cuadrante'
      ? extras + defectos + ausencias + decisiones + correccion
      : computado - (opciones.pactados ?? 0) + ausencias + decisiones + correccion

  return {
    minutos,
    detalle: { extras, defectos, computado, ausencias, decisiones, correccion },
    superaTopePositivo: politica.topePositivo !== null && minutos > politica.topePositivo,
    superaTopeNegativo: politica.topeNegativo !== null && minutos < -politica.topeNegativo,
  }
}

/**
 * Corrección de un periodo cerrado: se recalcula con los días de hoy y se compara con lo que
 * se guardó al cerrar. La diferencia va al periodo abierto.
 */
export const correccionDeCerrado = (
  saldoRecalculado: number,
  saldoAlCerrar: number,
) => saldoRecalculado - saldoAlCerrar
