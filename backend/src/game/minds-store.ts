import type { Pool } from 'pg';

/** SQL for Mind directors: the agency's linked Minds account and its director keys. */

export interface MindLinkRow {
  agencyId: string;
  mindsUserId: string;
  mindId: string | null;
  mindName: string | null;
  mindEmail: string | null;
  linkedAt: Date;
}

export interface DirectorKeyRow {
  id: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** What a director key resolves to: the agency, its owner, and the Mind directing it. */
export interface DirectorRow {
  keyId: string;
  agencyId: string;
  ownerUserId: string;
  mindId: string | null;
  mindName: string | null;
}

const linkCols = `agency_id AS "agencyId", minds_user_id AS "mindsUserId", mind_id AS "mindId", mind_name AS "mindName", mind_email AS "mindEmail", linked_at AS "linkedAt"`;
const keyCols = `id, prefix, created_at AS "createdAt", last_used_at AS "lastUsedAt", revoked_at AS "revokedAt"`;

export class MindsStore {
  constructor(private readonly pool: Pool) {}

  async link(agencyId: string): Promise<MindLinkRow | undefined> {
    const { rows } = await this.pool.query<MindLinkRow>(`SELECT ${linkCols} FROM pixel_agency.agency_minds WHERE agency_id = $1`, [agencyId]);
    return rows[0];
  }

  /**
   * Links (or re-links) the agency to a Minds account. Returns 'taken' when
   * that Minds account already directs another agency. Re-linking a
   * different account to the same agency replaces the old link.
   */
  async upsertLink(agencyId: string, mindsUserId: string): Promise<MindLinkRow | 'taken'> {
    try {
      const { rows } = await this.pool.query<MindLinkRow>(
        `INSERT INTO pixel_agency.agency_minds (agency_id, minds_user_id) VALUES ($1, $2)
         ON CONFLICT (agency_id) DO UPDATE SET minds_user_id = EXCLUDED.minds_user_id,
           mind_id = CASE WHEN pixel_agency.agency_minds.minds_user_id = EXCLUDED.minds_user_id THEN pixel_agency.agency_minds.mind_id END,
           mind_name = CASE WHEN pixel_agency.agency_minds.minds_user_id = EXCLUDED.minds_user_id THEN pixel_agency.agency_minds.mind_name END,
           mind_email = CASE WHEN pixel_agency.agency_minds.minds_user_id = EXCLUDED.minds_user_id THEN pixel_agency.agency_minds.mind_email END,
           updated_at = now()
         RETURNING ${linkCols}`,
        [agencyId, mindsUserId],
      );
      return rows[0]!;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return 'taken';
      throw err;
    }
  }

  async setMind(agencyId: string, mind: { mindId: string; name: string | null; email: string | null }): Promise<MindLinkRow> {
    const { rows } = await this.pool.query<MindLinkRow>(
      `UPDATE pixel_agency.agency_minds SET mind_id = $2, mind_name = $3, mind_email = $4, updated_at = now() WHERE agency_id = $1 RETURNING ${linkCols}`,
      [agencyId, mind.mindId, mind.name, mind.email],
    );
    return rows[0]!;
  }

  /** Removes the link and revokes every director key, in one transaction. */
  async unlink(agencyId: string): Promise<boolean> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const { rowCount } = await c.query(`DELETE FROM pixel_agency.agency_minds WHERE agency_id = $1`, [agencyId]);
      await c.query(`UPDATE pixel_agency.director_keys SET revoked_at = now() WHERE agency_id = $1 AND revoked_at IS NULL`, [agencyId]);
      await c.query('COMMIT');
      return (rowCount ?? 0) > 0;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  async activeKeyCount(agencyId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM pixel_agency.director_keys WHERE agency_id = $1 AND revoked_at IS NULL`, [agencyId]);
    return rows[0]!.n;
  }

  /** Inserts a key unless the agency already holds `max` active ones (checked under the agency row lock). */
  async insertKey(agencyId: string, keyHash: string, prefix: string, max: number): Promise<DirectorKeyRow | 'limit'> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT 1 FROM pixel_agency.agencies WHERE id = $1 FOR UPDATE`, [agencyId]);
      const { rows: n } = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM pixel_agency.director_keys WHERE agency_id = $1 AND revoked_at IS NULL`, [agencyId]);
      if (n[0]!.n >= max) {
        await c.query('ROLLBACK');
        return 'limit';
      }
      const { rows } = await c.query<DirectorKeyRow>(
        `INSERT INTO pixel_agency.director_keys (agency_id, key_hash, prefix) VALUES ($1, $2, $3) RETURNING ${keyCols}`,
        [agencyId, keyHash, prefix],
      );
      await c.query('COMMIT');
      return rows[0]!;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  async keys(agencyId: string): Promise<DirectorKeyRow[]> {
    const { rows } = await this.pool.query<DirectorKeyRow>(`SELECT ${keyCols} FROM pixel_agency.director_keys WHERE agency_id = $1 ORDER BY created_at DESC`, [agencyId]);
    return rows;
  }

  async revokeKey(agencyId: string, keyId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE pixel_agency.director_keys SET revoked_at = now() WHERE id = $2 AND agency_id = $1 AND revoked_at IS NULL`,
      [agencyId, keyId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** The agency this owner runs with this agent as CEO, if any. */
  async agencyRunBy(ownerUserId: string, agentId: string): Promise<string | undefined> {
    const { rows } = await this.pool.query<{ id: string }>(`SELECT id FROM pixel_agency.agencies WHERE owner_user_id = $1 AND ceo_agent_id = $2`, [ownerUserId, agentId]);
    return rows[0]?.id;
  }

  /** Resolves an active key; also records when it was last used. */
  async director(keyHash: string): Promise<DirectorRow | undefined> {
    const { rows } = await this.pool.query<DirectorRow>(
      `UPDATE pixel_agency.director_keys k SET last_used_at = now()
       FROM pixel_agency.agencies a LEFT JOIN pixel_agency.agency_minds m ON m.agency_id = a.id
       WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND a.id = k.agency_id
       RETURNING k.id AS "keyId", a.id AS "agencyId", a.owner_user_id AS "ownerUserId", m.mind_id AS "mindId", m.mind_name AS "mindName"`,
      [keyHash],
    );
    return rows[0];
  }
}
