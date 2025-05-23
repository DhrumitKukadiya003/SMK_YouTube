BEGIN;

-- Drop existing tables (if re-running the script)
-- Drop tables in reverse order of dependency or use CASCADE
DROP TABLE IF EXISTS katha_details CASCADE;
DROP TABLE IF EXISTS dhun_playlist CASCADE;
DROP TABLE IF EXISTS streamed_dhun_table CASCADE; -- Depends on dhun_dashboard_data indirectly
DROP TABLE IF EXISTS lyrical_video_dhun_table CASCADE; -- Depends on dhun_dashboard_data indirectly
DROP TABLE IF EXISTS dhun_jukebox_table CASCADE; -- Depends on dhun_dashboard_data indirectly
DROP TABLE IF EXISTS kirtan_dashboard_data CASCADE; -- New table for Kirtan Dashboard
DROP TABLE IF EXISTS dhun_dashboard_data CASCADE; -- Depends on videos
DROP TABLE IF EXISTS kirtan_playlist CASCADE;
DROP TABLE IF EXISTS streamed_kirtan_table CASCADE; -- Depends on dhun_dashboard_data indirectly
DROP TABLE IF EXISTS lyrical_video_kirtan_table CASCADE; -- Depends on dhun_dashboard_data indirectly
DROP TABLE IF EXISTS kirtan_jukebox_table CASCADE; -- Depends on dhun_dashboard_data indirectly
-- DROP TABLE IF EXISTS video_filters CASCADE; -- Added drop for video_filters table
DROP TABLE IF EXISTS videos CASCADE;
DROP TABLE IF EXISTS categories CASCADE; -- Dropping the old categories table
DROP TABLE IF EXISTS playlists CASCADE;
DROP TABLE IF EXISTS types CASCADE; -- Ensure CASCADE is included if needed

-- Create tables
CREATE TABLE playlists (
	playlist_id TEXT PRIMARY KEY,
	playlist_name TEXT NOT NULL,
	is_public BOOLEAN NOT NULL DEFAULT TRUE,
	is_active BOOLEAN NOT NULL DEFAULT TRUE
);

-- Renamed 'categories' to 'types'
CREATE TABLE types (
	type_id SERIAL PRIMARY KEY,
	type_name TEXT UNIQUE NOT NULL, -- This will now hold the 'Type' from description
	is_active BOOLEAN NOT NULL DEFAULT TRUE
);

-- Renamed 'sub_categories' to 'categories' and adjusted foreign key
CREATE TABLE categories (
	category_id SERIAL PRIMARY KEY,
	category_name TEXT UNIQUE NOT NULL, -- This will now hold the 'Category' from description
	type_id INTEGER NOT NULL, -- Foreign key to the new 'types' table
	is_active BOOLEAN NOT NULL DEFAULT TRUE,
	FOREIGN KEY (type_id) REFERENCES types(type_id) ON DELETE CASCADE
);

CREATE TABLE videos (
	id SERIAL PRIMARY KEY,
	video_id VARCHAR(255), -- This can be a YouTube or platform ID, allowed to be non-unique
	video_title TEXT NOT NULL,
	playlist_id TEXT, -- Foreign key to playlists table
	playlist_name TEXT, -- Denormalized playlist name
	type_id INTEGER NOT NULL, -- Foreign key to the new 'types' table
	category_id INTEGER NOT NULL, -- Foreign key to the new 'categories' table (formerly sub_categories)
	is_mixtv BOOLEAN NOT NULL DEFAULT FALSE,
	is_kathatv BOOLEAN NOT NULL DEFAULT FALSE,
	is_kirtantv BOOLEAN NOT NULL DEFAULT FALSE,
	is_dhuntv BOOLEAN NOT NULL DEFAULT FALSE,
	is_active BOOLEAN NOT NULL DEFAULT TRUE,
	channel_id TEXT,
	FOREIGN KEY (playlist_id) REFERENCES playlists(playlist_id) ON DELETE SET NULL,
	FOREIGN KEY (type_id) REFERENCES types(type_id) ON DELETE CASCADE,
	FOREIGN KEY (category_id) REFERENCES categories(category_id) ON DELETE CASCADE
);

CREATE TABLE katha_details (
	katha_id SERIAL PRIMARY KEY,
	video_id INTEGER UNIQUE NOT NULL, -- Foreign key referencing the 'id' in videos
	orator TEXT NOT NULL DEFAULT 'NA',
	sabha_number INTEGER NOT NULL DEFAULT 0,
	granth_name TEXT NOT NULL DEFAULT 'NA',
	playlist_id TEXT, -- Store associated playlist_id here as well
	playlist_name TEXT, -- Store associated playlist_name here as well
	FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
	-- Optional: Add foreign key to playlists if needed, though info likely comes via videos
	-- FOREIGN KEY (playlist_id) REFERENCES playlists(playlist_id) ON DELETE SET NULL
);

-- Adjusted columns in dhun_dashboard_data to match the new 'Type' and 'Category' structure
CREATE TABLE dhun_dashboard_data (
	id SERIAL PRIMARY KEY,
	video_db_id INTEGER, -- Added reference to videos.id
	video_id VARCHAR(255),
	video_title VARCHAR(255),
	channel_id VARCHAR(255),
	type_name VARCHAR(255), -- Renamed from category_name
	category_name VARCHAR(255), -- Renamed from sub_category_name
	playlist_id TEXT, -- Added playlist_id
	playlist_name TEXT -- Added playlist_name
	-- Optional: Add foreign key to videos if needed
	-- FOREIGN KEY (video_db_id) REFERENCES videos(id) ON DELETE CASCADE
);

-- NEW TABLE: kirtan_dashboard_data
-- This table will store data for the Kirtan dashboard, similar structure to dhun_dashboard_data

-- Note: These tables are created empty here.
-- The Node.js application will drop and recreate them based on dhun_dashboard_data.
-- Their structure depends on dhun_dashboard_data, which now includes playlist info.
CREATE TABLE streamed_dhun_table (LIKE dhun_dashboard_data INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES);
CREATE TABLE lyrical_video_dhun_table (LIKE dhun_dashboard_data INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES);
CREATE TABLE dhun_jukebox_table (LIKE dhun_dashboard_data INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES);

-- Removed initial CREATE TABLE AS SELECT here, Node.js handles refresh

-- Adjusted columns in dhun_playlist to match the new 'Type' and 'Category' structure
CREATE TABLE dhun_playlist (
	id SERIAL PRIMARY KEY,
	video_db_id INTEGER NOT NULL, -- Reference to videos.id
	video_id VARCHAR(255) NOT NULL,
	video_title VARCHAR(255) NOT NULL,
	channel_id VARCHAR(255), -- Added channel_id
	type_name VARCHAR(255), -- Renamed from category_name
	category_name VARCHAR(255), -- Renamed from sub_category_name
	playlist_id TEXT, -- Added playlist_id
	playlist_name TEXT, -- Added playlist_name
	playlist_order INTEGER NOT NULL,
	FOREIGN KEY (video_db_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE kirtan_dashboard_data (
    video_db_id INTEGER NOT NULL PRIMARY KEY, -- References videos.id
    video_id VARCHAR(255) NOT NULL,
    video_title VARCHAR(255) NOT NULL,
    channel_id VARCHAR(255),
    type_name VARCHAR(255),
    category_name VARCHAR(255),
    playlist_id TEXT,
    playlist_name TEXT,
    FOREIGN KEY (video_db_id) REFERENCES videos(id) ON DELETE CASCADE
);

/*CREATE TABLE video_filters (
    filter_id SERIAL PRIMARY KEY,
    filter_type TEXT NOT NULL,        -- e.g., 'video_id', 'video_title', 'playlist_id', 'playlist_name', 'privacy_status', 'Type', 'Category', 'Orator', 'Sabha Number/Track Number'
    filter_value TEXT NOT NULL,       -- The value to filter by
    matched_video_title TEXT,         -- Optional: For logging/debugging
    timestamp TIMESTAMPTZ DEFAULT NOW() -- When the filter was created/added
);*/
COMMIT;
