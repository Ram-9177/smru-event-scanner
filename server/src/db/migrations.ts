import type { Knex } from 'knex';
import { SCHEMA_SQL } from './schema.js';

/**
 * The database's history, as Knex migrations. They live in code (not in a folder Knex scans) so the same list
 * runs under tsx, the built server and the tests. Add a new entry at the end for every change; never edit one
 * that has already run.
 */
const LIST: Record<string, Knex.Migration> = {
  '001_initial': {
    // The tables of the build plan. Written so it also runs on a database that already has them.
    up: (knex) => knex.raw(SCHEMA_SQL),
    down: () => Promise.reject(new Error('The first migration is not undone.')),
  },
  '002_auth': {
    // Sign-in with Microsoft, and when each person last signed in (shown in Team).
    up: (knex) =>
      knex.schema.alterTable('users', (t) => {
        t.timestamp('last_sign_in_at', { useTz: true }).nullable();
        t.text('ms_oid').nullable().unique();
      }),
    down: (knex) =>
      knex.schema.alterTable('users', (t) => {
        t.dropColumn('last_sign_in_at');
        t.dropColumn('ms_oid');
      }),
  },
  '003_campuses_people_videos': {
    // Campuses (Hyderabad, Chebrolu, Budampadu ...), the People folders (main roles, sorted into Solo / Duo / Group),
    // videos, and student uploads waiting for approval again by default.
    up: async (knex) => {
      await knex.schema.createTable('campuses', (t) => {
        t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
        t.uuid('org_id').notNullable().references('orgs.id').onDelete('CASCADE');
        t.text('name').notNullable();
        t.text('slug').notNullable();
        t.integer('sort').notNullable().defaultTo(0);
        t.text('drive_folder_id');
        t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
        t.unique(['org_id', 'slug']);
      });
      await knex.schema.alterTable('events', (t) => {
        t.uuid('campus_id').references('campuses.id').onDelete('SET NULL');
      });
      await knex.schema.alterTable('media', (t) => {
        t.text('mime');
        t.integer('duration_ms');
        // A small MP4 every browser plays (H.264, 720p), made from the original video.
        t.text('video_key');
      });
      await knex.schema.alterTable('faces', (t) => {
        // For a face in a video: where in the video it was seen.
        t.integer('at_ms');
      });
      await knex.schema.createTable('people', (t) => {
        t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
        t.uuid('org_id').notNullable().references('orgs.id').onDelete('CASCADE');
        t.text('name').notNullable();
        t.text('role').notNullable().defaultTo('');
        t.uuid('campus_id').references('campuses.id').onDelete('SET NULL');
        t.integer('sort').notNullable().defaultTo(0);
        t.text('drive_folder_id');
        t.text('drive_folder_name');
        t.jsonb('drive_kind_folders').notNullable().defaultTo('{}');
        t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      });
      await knex.schema.createTable('person_refs', (t) => {
        t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
        t.uuid('person_id').notNullable().references('people.id').onDelete('CASCADE');
        t.binary('embedding').notNullable();
        t.text('model').notNullable();
        t.text('thumb_key');
        t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      });
      await knex.schema.createTable('person_media', (t) => {
        t.uuid('person_id').notNullable().references('people.id').onDelete('CASCADE');
        t.uuid('media_id').notNullable().references('media.id').onDelete('CASCADE');
        t.text('kind').notNullable().checkIn(['solo', 'duo', 'group']);
        t.specificType('similarity', 'real').notNullable();
        // The copy in the person's OneDrive folder (null until it is made).
        t.text('drive_item_id');
        t.text('drive_folder_kind');
        t.timestamp('filed_at', { useTz: true });
        t.primary(['person_id', 'media_id']);
        t.index(['media_id']);
      });
      // Photos from people the organisers do not know wait for approval (the owner's rule, 16 Nov 2026).
      await knex('events').update({ auto_approve: false });
    },
    down: async (knex) => {
      await knex.schema.dropTable('person_media');
      await knex.schema.dropTable('person_refs');
      await knex.schema.dropTable('people');
      await knex.schema.alterTable('faces', (t) => t.dropColumn('at_ms'));
      await knex.schema.alterTable('media', (t) => {
        t.dropColumn('mime');
        t.dropColumn('duration_ms');
        t.dropColumn('video_key');
      });
      await knex.schema.alterTable('events', (t) => t.dropColumn('campus_id'));
      await knex.schema.dropTable('campuses');
    },
  },
  '004_people_trash': {
    // People folders: which version of the original each copy was made from (a changed original is copied again),
    // and copies still to be removed from OneDrive. When a photo's row goes (its event was deleted, its file left
    // the folder), the database itself keeps the ids of its People copies here, so they can always be removed later.
    up: async (knex) => {
      await knex.schema.alterTable('person_media', (t) => {
        t.text('source_ctag');
      });
      await knex.raw(`update person_media pm set source_ctag = m.ctag from media m where m.id = pm.media_id`);
      await knex.schema.createTable('people_trash', (t) => {
        t.text('drive_item_id').primary();
        t.uuid('org_id').references('orgs.id').onDelete('CASCADE');
        t.integer('tries').notNullable().defaultTo(0);
        t.text('last_error');
        t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      });
      // Only when the photo itself is gone: a person removed from People keeps their copies (they are the college's photos),
      // and the app's own removals delete the copy first.
      await knex.raw(`
        create or replace function people_copy_left() returns trigger language plpgsql set search_path from current as $$
        begin
          if old.drive_item_id is not null and not exists (select 1 from media where id = old.media_id) then
            insert into people_trash (drive_item_id, org_id)
            values (old.drive_item_id, (select org_id from people where id = old.person_id))
            on conflict (drive_item_id) do nothing;
          end if;
          return null;
        end $$`);
      await knex.raw(`create trigger person_media_left after delete on person_media for each row execute function people_copy_left()`);
    },
    down: async (knex) => {
      await knex.raw(`drop trigger if exists person_media_left on person_media`);
      await knex.raw(`drop function if exists people_copy_left()`);
      await knex.schema.dropTable('people_trash');
      await knex.schema.alterTable('person_media', (t) => t.dropColumn('source_ctag'));
    },
  },
  '005_photo_quality': {
    // Each photo's fix (its "look": levels, mid-tones, colour; null when it needs none), applied to the album's
    // copies and to the full-quality download; whether an event fixes its photos (on unless an organiser turns it
    // off); and, for a video in a student's results, the moment their face is seen (the player starts there).
    up: async (knex) => {
      await knex.schema.alterTable('media', (t) => {
        t.jsonb('look');
      });
      await knex.schema.alterTable('events', (t) => {
        t.boolean('improve_photos').notNullable().defaultTo(true);
      });
      await knex.schema.alterTable('matches', (t) => {
        t.integer('at_ms');
      });
    },
    down: async (knex) => {
      await knex.schema.alterTable('matches', (t) => t.dropColumn('at_ms'));
      await knex.schema.alterTable('events', (t) => t.dropColumn('improve_photos'));
      await knex.schema.alterTable('media', (t) => t.dropColumn('look'));
    },
  },
  '006_copies_fixed': {
    // Whether a photo's album copies were made with its fix (Improve photos): so a switch that could not be finished
    // (OneDrive down, a restart) is finished later, and a photo whose copies are the same either way is never remade.
    // Copies already made as WebP were made with the event's current setting.
    up: async (knex) => {
      await knex.schema.alterTable('media', (t) => {
        t.boolean('copies_fixed');
      });
      await knex.raw(
        `update media m set copies_fixed = (m.look is not null and e.improve_photos) from events e where e.id = m.event_id and m.web_key like '%.webp'`,
      );
    },
    down: async (knex) => {
      await knex.schema.alterTable('media', (t) => t.dropColumn('copies_fixed'));
    },
  },
  '007_alerts_keep_removal_expiry': {
    // Everything for: Keep me updated (a student's own opt-in face vector, new matches, Web Push), Remove me (a
    // removal request listing photos), alerts for the organisers (with email), and face-data expiry / auto close.
    // Existing events keep face_days unset (the console gives new events 90 days).
    up: async (knex) => {
      await knex.schema.alterTable('events', (t) => {
        // "Close the album automatically on": a Live event becomes Closed on this day (the hourly job).
        t.date('close_on');
        // "Delete face data N days after the event". face_expiry_at (already there) is the moment it follows from.
        t.integer('face_days');
        // When the event's face data was deleted (expiry, archive, or "Delete face data now"). Set: face search is over.
        t.timestamp('face_deleted_at', { useTz: true });
        // Syncs in a row that failed (0 after one that worked): two or more raise the "sync is failing" alert.
        t.integer('sync_failures').notNullable().defaultTo(0);
      });
      await knex.schema.alterTable('guests', (t) => {
        // Keep me updated: guests.keep_updated and guests.embedding were there from the start. The wording version the
        // student agreed to, when, and which face model made the vector (vectors of two models are never compared).
        t.text('keep_consent_version');
        t.timestamp('keep_consent_at', { useTz: true });
        t.text('keep_model');
      });
      await knex.raw(`create index if not exists guests_kept on guests (event_id) where keep_updated`);
      await knex.schema.alterTable('matches', (t) => {
        // A match Keep me updated added that the student has not seen yet ("N new"); cleared when My prints is seen.
        t.boolean('fresh').notNullable().defaultTo(false);
        t.timestamp('added_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      });
      await knex.raw(`create index if not exists matches_fresh on matches (guest_id) where fresh`);
      // Web Push subscriptions of a phone for one event (a guest is one phone in one event). Gone with the guest.
      await knex.schema.createTable('push_subscriptions', (t) => {
        t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
        t.uuid('guest_id').notNullable().references('guests.id').onDelete('CASCADE');
        t.text('endpoint').notNullable();
        t.text('p256dh').notNullable();
        t.text('auth').notNullable();
        t.integer('failures').notNullable().defaultTo(0);
        t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
        t.timestamp('last_sent_at', { useTz: true });
        t.unique(['guest_id', 'endpoint']);
      });
      // The photos a removal request ("Remove me") is about: the student's sure matches when they asked.
      await knex.schema.createTable('request_media', (t) => {
        t.uuid('request_id').notNullable().references('requests.id').onDelete('CASCADE');
        t.uuid('media_id').notNullable().references('media.id').onDelete('CASCADE');
        t.primary(['request_id', 'media_id']);
        t.index(['media_id']);
      });
      // One open removal request per phone per event.
      await knex.raw(`create unique index if not exists requests_one_open_removal on requests (guest_id, event_id) where kind = 'removal' and status = 'open'`);
      await knex.schema.alterTable('users', (t) => {
        // Email alerts (problems, and the morning summary) for this super admin. On unless they turn it off.
        t.boolean('alert_emails').notNullable().defaultTo(true);
      });
      await knex.schema.alterTable('connections', (t) => {
        // When the stored Microsoft sign-in was last used to get a new token (Microsoft ends it after 90 days unused).
        t.timestamp('renewed_at', { useTz: true });
      });
      // Problems the organisers are told about. key: the kind, or kind:<event id> for one event's problem.
      // Active while cleared_at is null. emailed_at: the last email about it (at most one per 12 hours).
      await knex.schema.createTable('alerts', (t) => {
        t.text('key').primary();
        t.text('kind').notNullable();
        t.text('severity').notNullable().checkIn(['warn', 'critical']);
        t.uuid('event_id').references('events.id').onDelete('CASCADE');
        t.text('title').notNullable();
        t.text('detail');
        t.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
        t.timestamp('seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
        t.timestamp('emailed_at', { useTz: true });
        t.timestamp('cleared_at', { useTz: true });
      });
      // Small values the server keeps between restarts (the day the morning summary was last sent, ...).
      await knex.schema.createTable('app_state', (t) => {
        t.text('key').primary();
        t.jsonb('value');
        t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      });
    },
    down: async (knex) => {
      await knex.schema.dropTable('app_state');
      await knex.schema.dropTable('alerts');
      await knex.schema.alterTable('connections', (t) => t.dropColumn('renewed_at'));
      await knex.schema.alterTable('users', (t) => t.dropColumn('alert_emails'));
      await knex.raw(`drop index if exists requests_one_open_removal`);
      await knex.schema.dropTable('request_media');
      await knex.schema.dropTable('push_subscriptions');
      await knex.raw(`drop index if exists matches_fresh`);
      await knex.schema.alterTable('matches', (t) => {
        t.dropColumn('fresh');
        t.dropColumn('added_at');
      });
      await knex.raw(`drop index if exists guests_kept`);
      await knex.schema.alterTable('guests', (t) => {
        t.dropColumn('keep_consent_version');
        t.dropColumn('keep_consent_at');
        t.dropColumn('keep_model');
      });
      await knex.schema.alterTable('events', (t) => {
        t.dropColumn('close_on');
        t.dropColumn('face_days');
        t.dropColumn('face_deleted_at');
        t.dropColumn('sync_failures');
      });
    },
  },
  '008_onedrive_copies': {
    // Photos and videos live only in OneDrive: the album's copies, scene descriptions, download copies and People
    // reference thumbnails are files in "_app copies (do not edit)". Keys are od/<item id>/<name>. Copies that leave
    // the database are queued in copy_trash by triggers, so a crash can never strand one in OneDrive.
    up: async (knex) => {
      await knex.schema.alterTable('media', (t) => {
        t.text('scene_key'); // od/... scene description (was media/<e>/<id>_s.bin)
        t.text('clean_key'); // od/... a video without metadata, for downloads
        t.boolean('copies_missing').notNullable().defaultTo(false); // a copy is gone from OneDrive: rebuild it
        t.boolean('copies_lost').notNullable().defaultTo(false); // cannot be rebuilt: not shown to students
        t.integer('copies_tries').notNullable().defaultTo(0);
        t.text('copies_error');
        // A video's download copy that could not be made (no room, OneDrive nearly full, a container it cannot remux):
        // counted on its own, so it is not tried again on every pass (each try downloads the whole original).
        t.integer('clean_tries').notNullable().defaultTo(0);
      });
      await knex.schema.alterTable('events', (t) => {
        // {"root": <copies root id>, "event": <id>, "t": <id>, "w": ..., "v": ..., "s": ..., "clean": ..., "full": ...}
        t.jsonb('copies_folders').notNullable().defaultTo('{}');
      });
      await knex.schema.createTable('full_copies', (t) => {
        t.uuid('media_id').notNullable().references('media.id').onDelete('CASCADE');
        t.text('recipe').notNullable(); // fullcopy.ts nameOf hash: sha256 | look | RECIPE
        t.text('drive_item_id').notNullable().unique();
        t.text('name').notNullable();
        t.bigInteger('bytes').notNullable();
        t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
        t.timestamp('used_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
        t.primary(['media_id', 'recipe']);
        t.index(['used_at']);
      });
      await knex.schema.createTable('copy_trash', (t) => {
        t.text('drive_item_id').primary();
        t.boolean('folder').notNullable().defaultTo(false); // a whole event's copies folder (event deleted)
        t.uuid('event_id'); // no FK: the event may be gone
        t.integer('tries').notNullable().defaultTo(0);
        t.text('last_error');
        t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      });
      await knex.raw(`create or replace function copy_item(k text) returns text language sql immutable as $$
        select case when k like 'od/%' then split_part(k, '/', 2) end $$`);
      // media: any od key that leaves a column (set to null, replaced, or the row deleted, also through
      // "delete from events" cascades) is queued for removal, unless another column of the row still holds it.
      await knex.raw(`
        create or replace function media_copies_left() returns trigger language plpgsql set search_path from current as $$
        declare keep text[];
        begin
          keep := case when tg_op = 'DELETE' then '{}'::text[]
                       else array_remove(array[copy_item(new.thumb_key), copy_item(new.web_key), copy_item(new.video_key),
                                               copy_item(new.scene_key), copy_item(new.clean_key)], null) end;
          insert into copy_trash (drive_item_id, event_id)
          select distinct copy_item(k), old.event_id
            from unnest(array[old.thumb_key, old.web_key, old.video_key, old.scene_key, old.clean_key]) as k
           where copy_item(k) is not null and not (copy_item(k) = any(keep))
          on conflict (drive_item_id) do nothing;
          return null;
        end $$`);
      await knex.raw(`create trigger media_copies_left
        after update of thumb_key, web_key, video_key, scene_key, clean_key or delete on media
        for each row execute function media_copies_left()`);
      // full_copies and person_refs: the same rule for their single item.
      await knex.raw(`
        create or replace function full_copy_left() returns trigger language plpgsql set search_path from current as $$
        begin
          insert into copy_trash (drive_item_id, event_id)
          select old.drive_item_id, (select m.event_id from media m where m.id = old.media_id)
          on conflict do nothing;
          return null;
        end $$`);
      await knex.raw(`create trigger full_copy_left after delete on full_copies for each row execute function full_copy_left()`);
      await knex.raw(`
        create or replace function ref_thumb_left() returns trigger language plpgsql set search_path from current as $$
        begin
          if copy_item(old.thumb_key) is not null and (tg_op = 'DELETE' or copy_item(new.thumb_key) is distinct from copy_item(old.thumb_key)) then
            insert into copy_trash (drive_item_id) values (copy_item(old.thumb_key)) on conflict do nothing;
          end if;
          return null;
        end $$`);
      await knex.raw(`create trigger ref_thumb_left after update of thumb_key or delete on person_refs
        for each row execute function ref_thumb_left()`);
      // Legacy keys (media/..., people/...) are left as they are: the rebuild job reads them (media/rebuild.ts).
    },
    down: async (knex) => {
      await knex.raw(`drop trigger if exists ref_thumb_left on person_refs`);
      await knex.raw(`drop trigger if exists full_copy_left on full_copies`);
      await knex.raw(`drop trigger if exists media_copies_left on media`);
      await knex.raw(`drop function if exists ref_thumb_left()`);
      await knex.raw(`drop function if exists full_copy_left()`);
      await knex.raw(`drop function if exists media_copies_left()`);
      await knex.raw(`drop function if exists copy_item(text)`);
      await knex.schema.dropTable('copy_trash');
      await knex.schema.dropTable('full_copies');
      await knex.schema.alterTable('events', (t) => t.dropColumn('copies_folders'));
      await knex.schema.alterTable('media', (t) => {
        for (const c of ['scene_key', 'clean_key', 'copies_missing', 'copies_lost', 'copies_tries', 'copies_error', 'clean_tries']) t.dropColumn(c);
      });
    },
  },
};

export const migrations: Knex.MigrationSource<string> = {
  getMigrations: async () => Object.keys(LIST),
  getMigrationName: (name) => name,
  getMigration: async (name) => LIST[name],
};
