// API client for AnonForum
class APIClient {
    constructor() {
        // Auto-detect API URL
        this.baseURL = this.getBaseURL();
        this.timeout = 10000; // 10 seconds
        
        console.log('🔗 API Client initialized:', this.baseURL);
    }

    // Auto-detect base URL for different environments
    getBaseURL() {
        const hostname = window.location.hostname;
        const protocol = window.location.protocol;
        const port = window.location.port;
        
        // Production detection
        if (hostname.includes('vercel.app') || 
            hostname.includes('netlify.app') || 
            hostname.includes('railway.app') ||
            hostname.includes('render.com') ||
            hostname.includes('heroku.com')) {
            return `${protocol}//${hostname}`;
        }
        
        // Local development
        if (hostname === 'localhost' || hostname === '127.0.0.1') {
            // Try to detect if backend is running on different port
            const backendPort = port === '3000' ? '3001' : '3000';
            return `${protocol}//${hostname}:${backendPort}`;
        }
        
        // Default: same origin
        return '';
    }

    // Generic fetch wrapper with error handling
    async request(endpoint, options = {}) {
        const url = `${this.baseURL}/api${endpoint}`;
        
        const config = {
            timeout: this.timeout,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            },
            ...options
        };

        // Add timeout to fetch
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);
        config.signal = controller.signal;

        try {
            const response = await fetch(url, config);
            clearTimeout(timeoutId);

            // Handle non-JSON responses
            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                throw new Error(`Server returned ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || `HTTP ${response.status}: ${response.statusText}`);
            }

            return data;
        } catch (error) {
            clearTimeout(timeoutId);
            
            if (error.name === 'AbortError') {
                throw new Error('Request timeout - please check your connection');
            }
            
            if (error.message.includes('Failed to fetch')) {
                throw new Error('Cannot connect to server - please try again later');
            }
            
            throw error;
        }
    }

    // Health check
    async healthCheck() {
        try {
            return await this.request('/health');
        } catch (error) {
            console.warn('Health check failed:', error.message);
            throw new Error('Server unavailable');
        }
    }

    // Get posts with filtering and pagination
    async getPosts(params = {}) {
        const searchParams = new URLSearchParams();
        
        if (params.category && params.category !== 'all') {
            searchParams.set('category', params.category);
        }
        if (params.page) {
            searchParams.set('page', params.page.toString());
        }
        if (params.limit) {
            searchParams.set('limit', params.limit.toString());
        }
        if (params.sort) {
            searchParams.set('sort', params.sort);
        }

        const queryString = searchParams.toString();
        const endpoint = `/posts${queryString ? '?' + queryString : ''}`;
        
        return await this.request(endpoint);
    }

    // Get single post with comments
    async getPost(postId) {
        if (!postId) {
            throw new Error('Post ID is required');
        }
        return await this.request(`/posts/${postId}`);
    }

    // Create new post
    async createPost(postData) {
        if (!postData.title || !postData.content || !postData.category) {
            throw new Error('Title, content, and category are required');
        }

        return await this.request('/posts', {
            method: 'POST',
            body: JSON.stringify({
                title: postData.title.trim(),
                content: postData.content.trim(),
                category: postData.category,
                tags: Array.isArray(postData.tags) ? postData.tags : this.parseTags(postData.tags)
            })
        });
    }

    // Parse tags from string
    parseTags(tagsInput) {
        if (!tagsInput || typeof tagsInput !== 'string') return [];
        
        return tagsInput
            .split(',')
            .map(tag => tag.trim().toLowerCase())
            .filter(tag => tag.length > 0 && tag.length <= 50)
            .slice(0, 5);
    }

    // Like a post
    async likePost(postId) {
        if (!postId) {
            throw new Error('Post ID is required');
        }
        return await this.request(`/posts/${postId}/like`, { method: 'POST' });
    }

    // Create comment
    async createComment(postId, commentData) {
        if (!postId) {
            throw new Error('Post ID is required');
        }
        if (!commentData.content) {
            throw new Error('Comment content is required');
        }

        return await this.request(`/posts/${postId}/comments`, {
            method: 'POST',
            body: JSON.stringify({
                content: commentData.content.trim()
            })
        });
    }

    // Get comments for a post
    async getComments(postId) {
        if (!postId) {
            throw new Error('Post ID is required');
        }
        return await this.request(`/posts/${postId}/comments`);
    }

    // Get statistics
    async getStats() {
        return await this.request('/stats');
    }

    // Get online users count
    async getOnlineCount() {
        try {
            const response = await this.request('/online');
            return response.online || 0;
        } catch (error) {
            // Fallback to simulated count if endpoint fails
            return this.getSimulatedOnlineCount();
        }
    }

    // Fallback simulated online count
    getSimulatedOnlineCount() {
        const baseCount = 15;
        const variance = Math.floor(Math.random() * 30);
        const timeBonus = Math.floor(Math.sin(Date.now() / 600000) * 10);
        return Math.max(1, baseCount + variance + timeBonus);
    }

    // Search posts (if implemented on backend)
    async searchPosts(query, limit = 20) {
        if (!query || query.trim().length < 2) {
            throw new Error('Search query must be at least 2 characters');
        }

        const searchParams = new URLSearchParams({
            q: query.trim(),
            limit: limit.toString()
        });

        try {
            return await this.request(`/search?${searchParams.toString()}`);
        } catch (error) {
            // If search endpoint doesn't exist, return empty results
            if (error.message.includes('404')) {
                return { posts: [] };
            }
            throw error;
        }
    }

    // Retry mechanism for failed requests
    async requestWithRetry(endpoint, options = {}, maxRetries = 3) {
        let lastError;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await this.request(endpoint, options);
            } catch (error) {
                lastError = error;
                
                // Don't retry client errors (4xx)
                if (error.message.includes('400') || 
                    error.message.includes('401') || 
                    error.message.includes('403') || 
                    error.message.includes('404')) {
                    throw error;
                }
                
                // Wait before retry (exponential backoff)
                if (attempt < maxRetries) {
                    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    console.log(`Retrying request (attempt ${attempt + 1}/${maxRetries})...`);
                }
            }
        }
        
        throw lastError;
    }

    // Batch requests (for efficiency)
    async batchRequest(requests) {
        const promises = requests.map(({ endpoint, options }) => 
            this.request(endpoint, options).catch(error => ({ error: error.message }))
        );
        
        return await Promise.all(promises);
    }

    // Check if API is available
    async isAvailable() {
        try {
            await this.healthCheck();
            return true;
        } catch (error) {
            console.warn('API not available:', error.message);
            return false;
        }
    }

    // Get API status
    async getStatus() {
        try {
            const health = await this.healthCheck();
            return {
                available: true,
                status: health.status,
                uptime: health.uptime,
                stats: health.stats
            };
        } catch (error) {
            return {
                available: false,
                error: error.message
            };
        }
    }
}

// Create singleton instance
const API = new APIClient();

// Auto-check API availability on load
document.addEventListener('DOMContentLoaded', async () => {
    try {
        const isAvailable = await API.isAvailable();
        if (!isAvailable) {
            console.warn('⚠️ API server is not available - some features may not work');
            
            // Show warning to user
            if (window.app && typeof window.app.showNotification === 'function') {
                window.app.showNotification(
                    'Server không khả dụng. Một số tính năng có thể không hoạt động.',
                    'warning',
                    10000
                );
            }
        } else {
            console.log('✅ API server is available');
        }
    } catch (error) {
        console.warn('Could not check API availability:', error.message);
    }
});

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = APIClient;
} else {
    window.API = API;
    window.APIClient = APIClient;
}