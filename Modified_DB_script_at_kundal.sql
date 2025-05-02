BEGIN;

-- Drop existing tables (if re-running the script)
DROP TABLE IF EXISTS katha_details CASCADE;
DROP TABLE IF EXISTS videos CASCADE;
DROP TABLE IF EXISTS sub_categories CASCADE;
DROP TABLE IF EXISTS categories CASCADE;
DROP TABLE IF EXISTS playlists CASCADE;
DROP TABLE IF EXISTS video_filters CASCADE;
DROP TABLE IF EXISTS dhun_dashboard_data CASCADE;
DROP TABLE IF EXISTS dhun_playlist CASCADE;
DROP TABLE IF EXISTS streamed_dhun_table CASCADE;
DROP TABLE IF EXISTS lyrical_video_dhun_table CASCADE;
DROP TABLE IF EXISTS dhun_jukebox_table CASCADE;

-- Create tables

CREATE TABLE dhun_dashboard_data (
    id SERIAL PRIMARY KEY,
    video_id VARCHAR(255),
    video_title VARCHAR(255),
    channel_id VARCHAR(255),
    category_name VARCHAR(255),
    sub_category_name VARCHAR(255)
);

CREATE TABLE playlists (
    playlist_id TEXT PRIMARY KEY,
    playlist_name TEXT NOT NULL,
    is_public BOOLEAN NOT NULL DEFAULT TRUE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

-- Categories Table
CREATE TABLE categories (
    category_id SERIAL PRIMARY KEY,
    category_name TEXT UNIQUE NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

-- Sub-Categories Table
CREATE TABLE sub_categories (
    sub_category_id SERIAL PRIMARY KEY,
    sub_category_name TEXT UNIQUE NOT NULL,
    category_id INTEGER NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    FOREIGN KEY (category_id) REFERENCES categories(category_id) ON DELETE CASCADE
);

-- Videos Table
CREATE TABLE videos (
    id SERIAL PRIMARY KEY,
    video_id TEXT, -- This can be a YouTube or platform ID, allowed to be non-unique
    video_title TEXT NOT NULL,
    playlist_id TEXT NOT NULL,
    category_id INTEGER NOT NULL,
    sub_category_id INTEGER NOT NULL,
    is_mixtv BOOLEAN NOT NULL DEFAULT FALSE,
    is_kathatv BOOLEAN NOT NULL DEFAULT FALSE,
    is_kirtantv BOOLEAN NOT NULL DEFAULT FALSE,
    is_dhuntv BOOLEAN NOT NULL DEFAULT TRUE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    channel_id TEXT,
    FOREIGN KEY (playlist_id) REFERENCES playlists(playlist_id) ON DELETE CASCADE,
    FOREIGN KEY (category_id) REFERENCES categories(category_id) ON DELETE CASCADE,
    FOREIGN KEY (sub_category_id) REFERENCES sub_categories(sub_category_id) ON DELETE CASCADE
);

CREATE TABLE katha_details (
    katha_id SERIAL PRIMARY KEY,
    video_id INTEGER UNIQUE NOT NULL, -- Foreign key referencing the 'id' in videos
    orator TEXT NOT NULL DEFAULT 'NA',
    sabha_number INTEGER NOT NULL DEFAULT 0,
    granth_name TEXT NOT NULL DEFAULT 'NA',
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

-- Video Filters Table
CREATE TABLE video_filters (
    filter_id SERIAL PRIMARY KEY,
    filter_type TEXT NOT NULL,         -- e.g., 'video_id', 'video_title', 'playlist_id', 'playlist_name', 'privacy_status'
    filter_value TEXT NOT NULL,       -- The value to filter by
    matched_video_title TEXT,        -- Optional:  For logging/debugging
    timestamp TIMESTAMPTZ DEFAULT NOW()  -- When the filter was applied
);

COMMIT;