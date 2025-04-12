const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const { Pool } = require('pg');
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
const port = 3000;

// Configure PostgreSQL connection
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'youtube_db',
    password: 'postgres', // Change to your PostgreSQL password
    port: 5432,
});

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Set up EJS as the view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));



// Check for existing data on server start
app.get('/', async (req, res) => {
    try {
        const result = await pool.query('SELECT COUNT(*) FROM videos');
        const totalCount = parseInt(result.rows[0].count);
        if (totalCount > 0) {
            return res.redirect('/display');
        }
        res.render('index');
    } catch (error) {
        console.error('Error checking database:', error);
        res.status(500).send('Internal Server Error');
    }
});

app.post('/upload', upload.single('excelFile'), async (req, res) => {
    try {
        const channelId = req.body.channel_id;
        if (!req.file || !channelId) {
            return res.status(400).send('Missing file or channel selection.');
        }

        const workbook = xlsx.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const data1 = xlsx.utils.sheet_to_json(worksheet);
        const data = data1.filter(item => item['Video Title'] !== 'Private video');

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Delete old data for this channel
            await client.query(`DELETE FROM katha_details WHERE video_id IN (SELECT id FROM videos WHERE channel_id = $1)`, [channelId]);
            await client.query(`DELETE FROM videos WHERE channel_id = $1`, [channelId]);
            await client.query(`DELETE FROM playlists WHERE playlist_id IN (SELECT DISTINCT playlist_id FROM videos WHERE channel_id = $1)`, [channelId]);
            await client.query(`DELETE FROM sub_categories WHERE sub_category_id NOT IN (SELECT DISTINCT sub_category_id FROM videos)`);
            await client.query(`DELETE FROM categories WHERE category_id NOT IN (SELECT DISTINCT category_id FROM videos)`);

            for (const row of data) {
                const description = row.Description || '';

                const orator = (description.match(/Orator: ([^\n<]+)/) || [])[1]?.trim() || '';
                const sabhaNumber = parseInt((description.match(/Sabha Number: (\d+)/) || [])[1]) || 0;
                const granthName = (description.match(/Granth Name: ([^\n<]+)/) || [])[1]?.trim() || 'NA';

                const category = (description.match(/Category: ([^\n<]+)/) || [])[1]?.trim() || '';
                let subCategory = (description.match(/Sub Category: ([^\n<]+)/) || [])[1]?.trim() || '';
                if (!subCategory) {
                    subCategory = (description.match(/Type: ([^\n<]+)/) || [])[1]?.trim() || '';
                }

                // Determine flags based on category or description
                let isMixtv = false;
                let isKathatv = false;
                let isKirtantv = false;
                let isDhuntv = false;

                const terms = ['mix', 'katha', 'kirtan', 'dhun'];
                
                // Convert category to lowercase for case-insensitive comparison
                const categoryLower = category.toLowerCase();
                
                // Check for 'mix', 'katha', 'kirtan', 'dhun' using `some()` for 'mix' term
                if (terms.some(term => categoryLower.includes(term))) {
                    isMixtv = true;
                }
                
                // Now check for each specific term
                if (categoryLower.includes('katha')) {
                    isKathatv = true;
                }
                
                if (categoryLower.includes('kirtan')) {
                    isKirtantv = true;
                }
                
                if (categoryLower.includes('dhun')) {
                    isDhuntv = true;
                }
                

                // Avoid playlist duplication
                await client.query(`
                    INSERT INTO playlists (playlist_id, playlist_name, is_public)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (playlist_id) DO UPDATE SET playlist_name = EXCLUDED.playlist_name
                `, [row['Playlist Id'], row['Playlist Name'], row['Privacy Status'] === 'public']);

                const categoryRes = await client.query(`
                    INSERT INTO categories (type_name)
                    VALUES ($1)
                    ON CONFLICT (type_name) DO UPDATE SET type_name = EXCLUDED.type_name
                    RETURNING category_id
                `, [category]);
                const categoryId = categoryRes.rows[0].category_id;

                const subCatRes = await client.query(`
                    INSERT INTO sub_categories (category_name, category_id)
                    VALUES ($1, $2)
                    ON CONFLICT (category_name) DO UPDATE SET category_name = EXCLUDED.category_name
                    RETURNING sub_category_id
                `, [subCategory, categoryId]);
                const subCategoryId = subCatRes.rows[0].sub_category_id;

                // Insert video with flags
                const videoInsertRes = await client.query(`
                    INSERT INTO videos (
                        video_id, video_title, playlist_id, category_id, sub_category_id, channel_id,
                        is_mixtv, is_kathatv, is_kirtantv, is_dhuntv
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                    RETURNING id
                `, [
                    row['Video Id'], row['Video Title'], row['Playlist Id'], categoryId, subCategoryId, channelId,
                    isMixtv, isKathatv, isKirtantv, isDhuntv
                ]);
                const videoDbId = videoInsertRes.rows[0].id;

                // Insert into katha_details if available
                if (orator || sabhaNumber || granthName) {
                    await client.query(`
                        INSERT INTO katha_details (video_id, orator, sabha_number, granth_name)
                            VALUES ($1, $2, $3, $4)
                    `, [videoDbId, orator, sabhaNumber, granthName]);
                }
            }

            await client.query('COMMIT');
            res.redirect('/display?page=1&limit=10');
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Upload error:', err);
            res.status(500).send('Error during upload.');
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Upload handler failed:', error);
        res.status(500).send('Upload failed.');
    }
});



// Display data from database with pagination
app.get('/display', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        let limit = req.query.limit || 10;   // Default limit is 10

        const client = await pool.connect();

        // Fetch total count of videos
        const countResult = await client.query('SELECT COUNT(*) FROM videos');
        const totalRecords = parseInt(countResult.rows[0].count);

        let totalPages = Math.ceil(totalRecords / limit);

        // If 'all' is selected, fetch all records and disable pagination
        if (limit === "all") {
            limit = totalRecords;
            totalPages = 1;
        } else {
            limit = parseInt(limit, 10); // Ensure limit is parsed as an integer (base 10)
        }

        const offset = (page - 1) * limit;

        // Fetch video records with pagination (unless 'all' is selected)
        const videoQuery = `
            SELECT
                v.video_id,
                v.video_title,
                v.channel_id,
                c.type_name AS category_name,
                sc.category_name AS type_name,
                k.orator,
                k.sabha_number
            FROM videos v
            LEFT JOIN categories c ON v.category_id = c.category_id
            LEFT JOIN sub_categories sc ON v.sub_category_id = sc.sub_category_id
            LEFT JOIN katha_details k ON v.id = k.video_id
            ORDER BY v.video_id
            LIMIT $1 OFFSET $2;
        `;

        const videos = await client.query(videoQuery, [limit, offset]); // <--- LINE 65 (likely)

        client.release();

        res.render('display', {
            videos: videos.rows,
            currentPage: page,
            totalPages: totalPages,
            limit: req.query.limit || 10 // Maintain selected limit
        });

    } catch (err) {
        console.error('Error fetching videos:', err);
        res.status(500).send('Error retrieving video records.');
    }
});




const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

// Display playlists data
app.get('/playlists', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM playlists');
        res.render('playlists', { playlists: result.rows });
    } catch (err) {
        console.error('Error fetching playlists:', err);
        res.status(500).send('Internal Server Error');
    }
});


// Route to display the edit form
app.get('/edit/:video_id', async (req, res) => {
    const { video_id } = req.params;

    console.log(`Attempting to edit video with ID: ${video_id}`); // Log for debugging

    try {
        const result = await pool.query(`
            SELECT
                v.video_id,
                v.video_title,
                c.type_name AS category_name,
                s.category_name AS sub_category_name,
                k.orator,
                k.sabha_number
            FROM videos v
            LEFT JOIN categories c ON v.category_id = c.category_id
            LEFT JOIN sub_categories s ON v.sub_category_id = s.sub_category_id
            LEFT JOIN katha_details k ON v.id = k.video_id
            WHERE v.video_id = $1  -- Here the parameter is $1
        `, [video_id]);  // Pass the video_id as an array (no need to convert to integer)

        if (result.rows.length === 0) {
            return res.status(404).send('Video not found');
        }

        res.render('edit', { video: result.rows[0] });
    } catch (err) {
        console.error('Error fetching video:', err);
        res.status(500).send('Internal Server Error');
    }
});

// Route to handle updates
app.post('/update/:video_id', async (req, res) => {
    try {
        const { video_id } = req.params;  // video_id is passed as a string
        const { video_title, category_name, sub_category_name, orator, sabha_number } = req.body;

        // Update category
        let categoryResult = await pool.query(`
            INSERT INTO categories (type_name) 
            VALUES ($1)
            ON CONFLICT (type_name) DO UPDATE SET type_name = EXCLUDED.type_name
            RETURNING category_id
        `, [category_name]);

        const category_id = categoryResult.rows[0].category_id;

        // Update sub-category
        let subCategoryResult = await pool.query(`
            INSERT INTO sub_categories (category_name, category_id) 
            VALUES ($1, $2)
            ON CONFLICT (category_name) DO UPDATE SET category_name = EXCLUDED.category_name
            RETURNING sub_category_id
        `, [sub_category_name, category_id]);

        const sub_category_id = subCategoryResult.rows[0].sub_category_id;

        // Update video details (no need to parse video_id as an integer)
        await pool.query(`
            UPDATE videos 
            SET video_title = $1, category_id = $2, sub_category_id = $3
            WHERE video_id = $4
        `, [video_title, category_id, sub_category_id, video_id]);

        // 🔍 Lookup internal videos.id using the YouTube video_id
const idResult = await pool.query(`
    SELECT id FROM videos WHERE video_id = $1
`, [video_id]);

if (idResult.rows.length === 0) {
    return res.status(404).send('Video not found in database');
}

const videoDbId = idResult.rows[0].id;

// ✅ Use internal ID when inserting/updating katha_details
await pool.query(`
    INSERT INTO katha_details (video_id, orator, sabha_number) 
    VALUES ($1, $2, $3)
    ON CONFLICT (video_id) DO UPDATE SET orator = EXCLUDED.orator, sabha_number = EXCLUDED.sabha_number
`, [videoDbId, orator, sabha_number]);


        res.redirect('/display');
    } catch (err) {
        console.error('Error updating video:', err);
        res.status(500).send('Internal Server Error');
    }
});

app.get('/export', async (req, res) => {
    try {
        const client = await pool.connect();

        const result = await client.query(`
            SELECT 
                v.video_id,
                v.video_title,
                v.channel_id,
                p.playlist_id,
                p.playlist_name,
                c.type_name AS category,
                sc.category_name AS sub_category,
                k.orator,
                k.sabha_number
            FROM videos v
            LEFT JOIN playlists p ON v.playlist_id = p.playlist_id
            LEFT JOIN categories c ON v.category_id = c.category_id
            LEFT JOIN sub_categories sc ON v.sub_category_id = sc.sub_category_id
            LEFT JOIN katha_details k ON v.id = k.video_id
            ORDER BY v.video_id
        `);

        client.release();

        const videos = result.rows;

        // Format data for Excel
        const excelData = videos.map(video => ({
            "Video ID": video.video_id,
            "Video Title": video.video_title,
            "Channel ID": video.channel_id,
            "Playlist ID": video.playlist_id,
            "Playlist Name": video.playlist_name,
            "Category": video.category,
            "Sub Category": video.sub_category,
            "Orator": video.orator || '',
            "Sabha/Track Number": video.sabha_number || ''
        }));

        // Create worksheet and workbook
        const worksheet = xlsx.utils.json_to_sheet(excelData);
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, worksheet, "Videos");

        // Generate buffer and send as download
        const exportFile = xlsx.write(workbook, { type: "buffer", bookType: "xlsx" });
        res.setHeader("Content-Disposition", "attachment; filename=videos_export.xlsx");
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.send(exportFile);
    } catch (err) {
        console.error("Export error:", err);
        res.status(500).send("Failed to export video data.");
    }
});
