const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');

// Import routes and middleware
const DataStore = require('./models/data');
const security = require('./middleware/security');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize data store
const dataStore = new DataStore();

// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'"]
        }
    }
}));

// CORS configuration
app.use(cors({
    origin: process.env.NODE_ENV === 'production' 
        ? [process.env.FRONTEND_URL, 'https://anonforum-shared.vercel.app'] 
        : ['http://localhost:3000', 'http://127.0.0.1:3000'],
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type']
}));

// Compression
app.use(compression());

// Body parsing
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

// Rate limiting
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // 100 requests per windowMs per IP
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false
});

const postLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 3, // 3 posts per 5 minutes
    message: { error: 'Too many posts, please slow down.' }
});

const commentLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 5, // 5 comments per minute
    message: { error: 'Too many comments, please slow down.' }
});

app.use('/api', globalLimiter);

// Security middleware
app.use('/api', security.sanitizeInput);
app.use('/api', security.validateInput);

// Serve static files (for platforms that need it)
if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.join(__dirname, '../frontend')));
}

// API Routes

// Health check
app.get('/api/health', (req, res) => {
    const stats = dataStore.getStats();
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        memory: {
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
            total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
        },
        stats
    });
});

// Get all posts
app.get('/api/posts', (req, res) => {
    try {
        const { category, page = 1, limit = 20, sort = 'timestamp' } = req.query;
        
        const pageNum = Math.max(1, parseInt(page));
        const limitNum = Math.min(50, Math.max(1, parseInt(limit)));
        
        const posts = dataStore.getPosts({
            category: category !== 'all' ? category : undefined,
            page: pageNum,
            limit: limitNum,
            sort
        });
        
        res.json(posts);
    } catch (error) {
        console.error('Error getting posts:', error);
        res.status(500).json({ error: 'Failed to get posts' });
    }
});

// Get single post with comments
app.get('/api/posts/:id', (req, res) => {
    try {
        const post = dataStore.getPost(req.params.id);
        
        if (!post) {
            return res.status(404).json({ error: 'Post not found' });
        }
        
        res.json(post);
    } catch (error) {
        console.error('Error getting post:', error);
        res.status(500).json({ error: 'Failed to get post' });
    }
});

// Create new post
app.post('/api/posts', postLimiter, (req, res) => {
    try {
        const { title, content, category, tags } = req.body;
        
        // Validation
        if (!title || !content || !category) {
            return res.status(400).json({ error: 'Title, content, and category are required' });
        }
        
        if (title.length < 3 || title.length > 200) {
            return res.status(400).json({ error: 'Title must be 3-200 characters' });
        }
        
        if (content.length < 10 || content.length > 2000) {
            return res.status(400).json({ error: 'Content must be 10-2000 characters' });
        }
        
        const validCategories = ['general', 'tech', 'crypto', 'society', 'confession', 'question', 'random'];
        if (!validCategories.includes(category)) {
            return res.status(400).json({ error: 'Invalid category' });
        }
        
        // Create post
        const postData = {
            title: title.trim(),
            content: content.trim(),
            category,
            tags: Array.isArray(tags) ? tags.slice(0, 5) : [],
            ipHash: security.hashIP(req.ip || req.connection.remoteAddress)
        };
        
        const newPost = dataStore.createPost(postData);
        
        res.status(201).json({
            success: true,
            post: newPost
        });
        
    } catch (error) {
        console.error('Error creating post:', error);
        res.status(500).json({ error: 'Failed to create post' });
    }
});

// Like a post
app.post('/api/posts/:id/like', rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10, // 10 likes per minute
    message: { error: 'Too many likes, please slow down' }
}), (req, res) => {
    try {
        const result = dataStore.likePost(req.params.id, req.ip);
        
        if (result.success) {
            res.json({ success: true, likes: result.likes });
        } else {
            res.status(400).json({ error: result.message });
        }
    } catch (error) {
        console.error('Error liking post:', error);
        res.status(500).json({ error: 'Failed to like post' });
    }
});

// Create comment
app.post('/api/posts/:id/comments', commentLimiter, (req, res) => {
    try {
        const { content } = req.body;
        const postId = req.params.id;
        
        // Validation
        if (!content || content.trim().length < 1) {
            return res.status(400).json({ error: 'Comment content is required' });
        }
        
        if (content.length > 1000) {
            return res.status(400).json({ error: 'Comment must be under 1000 characters' });
        }
        
        const commentData = {
            content: content.trim(),
            ipHash: security.hashIP(req.ip || req.connection.remoteAddress)
        };
        
        const result = dataStore.createComment(postId, commentData);
        
        if (result.success) {
            res.status(201).json({
                success: true,
                comment: result.comment
            });
        } else {
            res.status(404).json({ error: result.message });
        }
        
    } catch (error) {
        console.error('Error creating comment:', error);
        res.status(500).json({ error: 'Failed to create comment' });
    }
});

// Get comments for a post
app.get('/api/posts/:id/comments', (req, res) => {
    try {
        const comments = dataStore.getComments(req.params.id);
        res.json({ comments });
    } catch (error) {
        console.error('Error getting comments:', error);
        res.status(500).json({ error: 'Failed to get comments' });
    }
});

// Get statistics
app.get('/api/stats', (req, res) => {
    try {
        const stats = dataStore.getStats();
        res.json(stats);
    } catch (error) {
        console.error('Error getting stats:', error);
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

// Online users simulation
app.get('/api/online', (req, res) => {
    const baseCount = 20;
    const variance = Math.floor(Math.random() * 50);
    const timeBonus = Math.floor(Math.sin(Date.now() / 600000) * 15);
    const count = Math.max(1, baseCount + variance + timeBonus);
    
    res.json({ online: count });
});

// Fallback for SPA (if serving frontend)
if (process.env.NODE_ENV === 'production') {
    app.get('*', (req, res) => {
        res.sendFile(path.join(__dirname, '../frontend/index.html'));
    });
}

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({
        error: process.env.NODE_ENV === 'production' 
            ? 'Internal server error' 
            : error.message
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Cleanup job - run every hour
setInterval(() => {
    try {
        const cleaned = dataStore.cleanup();
        if (cleaned > 0) {
            console.log(`Cleaned up ${cleaned} old posts`);
        }
    } catch (error) {
        console.error('Cleanup error:', error);
    }
}, 60 * 60 * 1000); // 1 hour

// Start server
app.listen(PORT, () => {
    console.log(`🚀 AnonForum server running on port ${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`💾 Storage: In-memory (restart will clear data)`);
    
    // Initialize with sample data in development
    if (process.env.NODE_ENV !== 'production') {
        dataStore.initSampleData();
        console.log('📝 Sample data loaded');
    }
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully');
    process.exit(0);
});

module.exports = app;