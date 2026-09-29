-- Registro inalterable en PostgreSQL.
--
-- 1. Las tablas del registro solo admiten INSERT: UPDATE, DELETE y TRUNCATE se rechazan
--    incluso a un superusuario. ENABLE ALWAYS evita que `session_replication_role = replica`
--    se salte los triggers.
-- 2. Cada fila se encadena por hash con la anterior de la MISMA persona. Lo calcula la base,
--    no la aplicación. Si alguien con acceso total modifica o borra una fila, la cadena lo delata.
-- 3. La aplicación conecta con un rol que no es dueño de nada: no puede desactivar triggers.

-- 1 · Solo crecer ------------------------------------------------------------------------------

CREATE FUNCTION rechazar_cambios() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% es un registro inalterable: no admite %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Las correcciones se añaden, nunca se edita ni se borra.';
END $$;

CREATE FUNCTION hacer_inalterable(tabla regclass) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  n text := (SELECT relname FROM pg_class WHERE oid = tabla);
BEGIN
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %s
                  FOR EACH ROW EXECUTE FUNCTION rechazar_cambios()', n || '_sin_cambios', tabla);
  -- TRUNCATE no dispara triggers de fila: hace falta uno de sentencia.
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %s
                  FOR EACH STATEMENT EXECUTE FUNCTION rechazar_cambios()', n || '_sin_truncate', tabla);
  EXECUTE format('ALTER TABLE %s ENABLE ALWAYS TRIGGER %I', tabla, n || '_sin_cambios');
  EXECUTE format('ALTER TABLE %s ENABLE ALWAYS TRIGGER %I', tabla, n || '_sin_truncate');
END $$;

-- 2 · Cadena de hashes por persona -------------------------------------------------------------

CREATE TABLE cabezas_cadena (
  tabla      text        NOT NULL,
  persona_id uuid        NOT NULL,
  hash       text        NOT NULL,
  actualizado timestamptz NOT NULL,
  PRIMARY KEY (tabla, persona_id)
);

-- hash = sha256(hash_anterior ‖ fila_en_jsonb_sin_columnas_de_hash)
-- La zona se fija a UTC: cómo se serializa un timestamptz en jsonb depende de la sesión, y el
-- hash no puede depender de quién inserta ni de quién verifica.
CREATE FUNCTION encadenar() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
SET timezone TO 'UTC'
AS $$
DECLARE
  previo text;
BEGIN
  -- Dos inserciones simultáneas de la misma persona no pueden colgar de la misma cabeza.
  PERFORM pg_advisory_xact_lock(hashtextextended(TG_TABLE_NAME || ':' || NEW.persona_id::text, 0));

  SELECT hash INTO previo FROM cabezas_cadena
   WHERE tabla = TG_TABLE_NAME AND persona_id = NEW.persona_id;

  NEW.hash_anterior := coalesce(previo, repeat('0', 64));
  NEW.hash := encode(sha256(convert_to(
    NEW.hash_anterior || (to_jsonb(NEW) - 'hash' - 'hash_anterior')::text, 'UTF8')), 'hex');

  INSERT INTO cabezas_cadena (tabla, persona_id, hash, actualizado)
  VALUES (TG_TABLE_NAME, NEW.persona_id, NEW.hash, now())
  ON CONFLICT (tabla, persona_id)
  DO UPDATE SET hash = EXCLUDED.hash, actualizado = EXCLUDED.actualizado;
  RETURN NEW;
END $$;

-- Los triggers BEFORE se ejecutan por orden alfabético: «zzz_» garantiza que este es el último
-- y que nada cambia la fila después de calcular su hash.
CREATE FUNCTION activar_cadena(tabla regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE TRIGGER zzz_cadena BEFORE INSERT ON %s
                  FOR EACH ROW EXECUTE FUNCTION encadenar()', tabla);
  EXECUTE format('ALTER TABLE %s ENABLE ALWAYS TRIGGER zzz_cadena', tabla);
END $$;

-- 3 · Verificación -----------------------------------------------------------------------------
-- Devuelve cada problema encontrado; vacío = cadena íntegra.

CREATE FUNCTION verificar_cadena(tabla regclass)
RETURNS TABLE (persona_id uuid, problema text)
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
SET timezone TO 'UTC'
AS $$
BEGIN
  RETURN QUERY EXECUTE format($q$
    WITH filas AS (
      SELECT t.persona_id, t.hash, t.hash_anterior,
             encode(sha256(convert_to(
               t.hash_anterior || (to_jsonb(t) - 'hash' - 'hash_anterior')::text, 'UTF8')), 'hex') AS recalculado
        FROM %s t
    )
    -- Contenido alterado
    SELECT persona_id, 'fila alterada: ' || hash FROM filas WHERE hash <> recalculado
    UNION ALL
    -- Falta el eslabón anterior (fila borrada)
    SELECT f.persona_id, 'eslabón roto antes de: ' || f.hash
      FROM filas f
     WHERE f.hash_anterior <> repeat('0', 64)
       AND NOT EXISTS (SELECT 1 FROM filas g
                        WHERE g.persona_id = f.persona_id AND g.hash = f.hash_anterior)
    UNION ALL
    -- Dos filas cuelgan de la misma anterior
    SELECT persona_id, 'bifurcación en: ' || hash_anterior
      FROM filas GROUP BY persona_id, hash_anterior HAVING count(*) > 1
  $q$, tabla);
END $$;

-- Uso -----------------------------------------------------------------------------------------

CREATE TABLE fichajes (
  id                uuid PRIMARY KEY,           -- en el panel sin conexión, el uuid de la tablet
  persona_id        uuid NOT NULL,
  tipo              text NOT NULL CHECK (tipo IN ('entrada','inicio_pausa','fin_pausa','salida')),
  origen            text NOT NULL,
  momento_servidor  timestamptz NOT NULL DEFAULT clock_timestamp(),
  momento_efectivo  timestamptz NOT NULL,
  hash_anterior     text NOT NULL,
  hash              text NOT NULL
);

SELECT hacer_inalterable('fichajes');
SELECT activar_cadena('fichajes');

-- La aplicación solo lee e inserta:
-- GRANT SELECT, INSERT ON fichajes TO <rol_aplicacion>;
