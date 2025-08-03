const crypto = require('crypto');

class DataStore {
    constructor() {
        this.posts = [];
        this.postIdCounter = 1;
        this.commentIdCounter = 1;
        this.likedPosts = new Map(); // IP hash -> Set of post IDs
        this.maxPosts = 500; // Limit total posts
        this.maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
        
        console.log('📊 DataStore initialized (in-memory)');
    }

    // Generate unique ID
    generateId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
    }

    // Generate anonymous ID
    generateAnonId() {
        const prefixes = [
            'Anon', 'Ghost', 'Shadow', 'Phantom', 'Mystery', 'Unknown',
            'Cipher', 'Void', 'Echo', 'Raven', 'Sage', 'Nova', 'Zen'
        ];
        const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
        const number = Math.floor(Math.random() * 9999) + 1000;
        return `${prefix}${number}`;
    }

    // Create new post
    createPost({ title, content, category, tags = [], ipHash }) {
        const post = {
            id: this.generateId(),
            anonId: this.generateAnonId(),
            title,
            content,
            category,
            tags: tags.slice(0, 5), // Max 5 tags
            timestamp: Date.now(),
            likes: 0,
            comments: [],
            ipHash,
            expiresAt: Date.now() + this.maxAge
        };

        this.posts.unshift(post); // Add to beginning
        
        // Keep only max posts
        if (this.posts.length > this.maxPosts) {
            this.posts = this.posts.slice(0, this.maxPosts);
        }

        return this.sanitizePost(post);
    }

    // Get posts with filtering and pagination
    getPosts({ category, page = 1, limit = 20, sort = 'timestamp' } = {}) {
        let filtered = this.posts.filter(post => {
            // Filter expired posts
            if (post.expiresAt < Date.now()) return false;
            
            // Filter by category
            if (category && post.category !== category) return false;
            
            return true;
        });

        // Sort posts
        switch (sort) {
            case 'likes':
                filtered.sort((a, b) => b.likes - a.likes);
                break;
            case 'comments':
                filtered.sort((a, b) => b.comments.length - a.comments.length);
                break;
            case 'timestamp':
            default:
                filtered.sort((a, b) => b.timestamp - a.timestamp);
                break;
        }

        // Pagination
        const total = filtered.length;
        const totalPages = Math.ceil(total / limit);
        const offset = (page - 1) * limit;
        const paginatedPosts = filtered.slice(offset, offset + limit);

        return {
            posts: paginatedPosts.map(post => this.sanitizePost(post)),
            pagination: {
                current: page,
                total: totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1,
                totalPosts: total
            }
        };
    }

    // Get single post
    getPost(id) {
        const post = this.posts.find(p => p.id === id);
        
        if (!post || post.expiresAt < Date.now()) {
            return null;
        }

        return this.sanitizePost(post);
    }

    // Like a post
    likePost(postId, userIP) {
        const post = this.posts.find(p => p.id === postId);
        
        if (!post || post.expiresAt < Date.now()) {
            return { success: false, message: 'Post not found' };
        }

        const ipHash = this.hashIP(userIP);
        
        // Check if already liked
        if (!this.likedPosts.has(ipHash)) {
            this.likedPosts.set(ipHash, new Set());
        }
        
        const userLikes = this.likedPosts.get(ipHash);
        
        if (userLikes.has(postId)) {
            return { success: false, message: 'Already liked' };
        }

        // Add like
        post.likes++;
        userLikes.add(postId);

        return { success: true, likes: post.likes };
    }

    // Create comment
    createComment(postId, { content, ipHash }) {
        const post = this.posts.find(p => p.id === postId);
        
        if (!post || post.expiresAt < Date.now()) {
            return { success: false, message: 'Post not found' };
        }

        const comment = {
            id: this.generateId(),
            anonId: this.generateAnonId(),
            content,
            timestamp: Date.now(),
            ipHash
        };

        post.comments.push(comment);

        return { 
            success: true, 
            comment: this.sanitizeComment(comment) 
        };
    }

    // Get comments for a post
    getComments(postId) {
        const post = this.posts.find(p => p.id === postId);
        
        if (!post || post.expiresAt < Date.now()) {
            return [];
        }

        return post.comments.map(comment => this.sanitizeComment(comment));
    }

    // Get statistics
    getStats() {
        const now = Date.now();
        const validPosts = this.posts.filter(post => post.expiresAt > now);
        
        const totalComments = validPosts.reduce((sum, post) => sum + post.comments.length, 0);
        const totalLikes = validPosts.reduce((sum, post) => sum + post.likes, 0);
        
        // Recent activity (last 24 hours)
        const oneDayAgo = now - (24 * 60 * 60 * 1000);
        const recentPosts = validPosts.filter(post => post.timestamp > oneDayAgo);
        const recentComments = validPosts.reduce((count, post) => {
            return count + post.comments.filter(comment => comment.timestamp > oneDayAgo).length;
        }, 0);

        return {
            totalPosts: validPosts.length,
            totalComments,
            totalLikes,
            postsToday: recentPosts.length,
            commentsToday: recentComments,
            categories: this.getCategoryStats(validPosts),
            memoryUsage: {
                posts: this.posts.length,
                maxPosts: this.maxPosts,
                usage: Math.round((this.posts.length / this.maxPosts) * 100)
            }
        };
    }

    // Get category statistics
    getCategoryStats(posts = null) {
        const validPosts = posts || this.posts.filter(post => post.expiresAt > Date.now());
        const stats = {};
        
        validPosts.forEach(post => {
            stats[post.category] = (stats[post.category] || 0) + 1;
        });
        
        return stats;
    }

    // Clean up expired posts
    cleanup() {
        const now = Date.now();
        const initialLength = this.posts.length;
        
        this.posts = this.posts.filter(post => post.expiresAt > now);
        
        // Clean up liked posts map
        this.cleanupLikedPosts();
        
        const removedCount = initialLength - this.posts.length;
        
        if (removedCount > 0) {
            console.log(`🧹 Cleaned up ${removedCount} expired posts`);
        }
        
        return removedCount;
    }

    // Clean up liked posts map (remove expired entries)
    cleanupLikedPosts() {
        const validPostIds = new Set(this.posts.map(post => post.id));
        
        for (const [ipHash, likedSet] of this.likedPosts) {
            // Remove likes for posts that no longer exist
            for (const postId of likedSet) {
                if (!validPostIds.has(postId)) {
                    likedSet.delete(postId);
                }
            }
            
            // Remove empty sets
            if (likedSet.size === 0) {
                this.likedPosts.delete(ipHash);
            }
        }
    }

    // Hash IP for privacy
    hashIP(ip) {
        const salt = process.env.IP_SALT || 'anonforum-salt-2024';
        return crypto.createHash('sha256').update(ip + salt).digest('hex');
    }

    // Remove sensitive data from post
    sanitizePost(post) {
        const { ipHash, ...sanitized } = post;
        return {
            ...sanitized,
            comments: post.comments.map(comment => this.sanitizeComment(comment))
        };
    }

    // Remove sensitive data from comment
    sanitizeComment(comment) {
        const { ipHash, ...sanitized } = comment;
        return sanitized;
    }

    // Initialize with sample data
    initSampleData() {
        if (this.posts.length > 0) return;

        const samplePosts = [
            {
                title: "Welcome to AnonForum!",
                content: "Đây là diễn đàn thảo luận ẩn danh đầu tiên của chúng ta. Hãy thảo luận một cách văn minh và tôn trọng lẫn nhau. Dữ liệu sẽ được lưu trữ trong 7 ngày và tự động xóa.",
                category: "general",
                tags: ["welcome", "rules", "community"],
                timestamp: Date.now() - 2 * 60 * 60 * 1000
            },
            {
                title: "AI và tương lai của lập trình",
                content: "ChatGPT, Claude, GitHub Copilot đang thay đổi cách chúng ta code. Các bạn nghĩ sao về việc AI sẽ thay thế lập trình viên? Hay nó chỉ là công cụ hỗ trợ?",
                category: "tech",
                tags: ["ai", "programming", "future", "automation"],
                timestamp: Date.now() - 4 * 60 * 60 * 1000
            },
            {
                title: "Crypto winter có kết thúc không?",
                content: "Bitcoin sideway mãi, altcoin xuống hoài. Thị trường crypto có hồi phục không? Hay đây là dấu hiệu của việc crypto không bền vững?",
                category: "crypto",
                tags: ["bitcoin", "altcoin", "market", "investment"],
                timestamp: Date.now() - 6 * 60 * 60 * 1000
            }
        ];

        samplePosts.forEach((postData, index) => {
            const post = {
                id: this.generateId(),
                anonId: this.generateAnonId(),
                title: postData.title,
                content: postData.content,
                category: postData.category,
                tags: postData.tags,
                timestamp: postData.timestamp,
                likes: Math.floor(Math.random() * 10) + 1,
                comments: [],
                ipHash: this.hashIP(`sample-ip-${index}`),
                expiresAt: Date.now() + this.maxAge
            };

            // Add some sample comments
            if (index === 0) {
                post.comments.push({
                    id: this.generateId(),
                    anonId: this.generateAnonId(),
                    content: "Cảm ơn admin đã tạo ra forum này! Rất hữu ích cho community.",
                    timestamp: Date.now() - 1 * 60 * 60 * 1000,
                    ipHash: this.hashIP('sample-commenter-1')
                });
            }

            this.posts.push(post);
        });

        console.log(`📝 Loaded ${samplePosts.length} sample posts`);
    }

    // Get trending tags
    getTrendingTags(limit = 10) {
        const now = Date.now();
        const validPosts = this.posts.filter(post => post.expiresAt > now);
        const tagCounts = {};
        
        validPosts.forEach(post => {
            post.tags.forEach(tag => {
                tagCounts[tag] = (tagCounts[tag] || 0) + 1;
            });
        });
        
        return Object.entries(tagCounts)
            .sort(([,a], [,b]) => b - a)
            .slice(0, limit)
            .map(([tag, count]) => ({ tag, count }));
    }

    // Search posts
    searchPosts(query, limit = 20) {
        if (!query || query.trim().length < 2) return [];
        
        const searchTerm = query.toLowerCase().trim();
        const now = Date.now();
        
        return this.posts
            .filter(post => {
                if (post.expiresAt < now) return false;
                
                return post.title.toLowerCase().includes(searchTerm) ||
                       post.content.toLowerCase().includes(searchTerm) ||
                       post.tags.some(tag => tag.toLowerCase().includes(searchTerm));
            })
            .slice(0, limit)
            .map(post => this.sanitizePost(post));
    }
}

module.exports = DataStore;