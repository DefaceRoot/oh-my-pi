# Image Support

The user is asking for the complete documentation of the 'Image Support' section, which is part of the 'Usage' section in the `README.md` file . This section describes how images are handled, including attaching images, supported formats, and configuration options for displaying images in the terminal .

## Image Support

The system provides robust image support, allowing you to attach images by reference or by pasting them directly .

### Attaching Images

You can attach images by referencing their file path within your prompts .

**Example:**
```text
What's in @/path/to/image.png?
``` 

Alternatively, you can paste or drag-and-drop images directly into the interface using `Ctrl+V` .

### Supported Formats

The following image formats are supported: `.jpg`, `.jpeg`, `.png`, `.gif`, and `.webp` .

### Configuration

You can control the inline display of images in the terminal through settings .

**Toggle Inline Images:**
Use the `/settings` command or set the `terminal.showImages` configuration option to `false` to disable inline image rendering . This setting is defined in `packages/coding-agent/src/config/settings-schema.ts` .

```typescript
"terminal.showImages": {
    type: "boolean",
    default: true,
    ui: {
        tab: "display",
        label: "Show images",
        description: "Render images inline in terminal",
        condition: "hasImageProtocol",
    },
},
``` 

Additionally, there are settings for automatic image resizing to ensure compatibility with models :

```typescript
"images.autoResize": {
    type: "boolean",
    default: true,
    ui: {
        tab: "display",
        label: "Auto-resize images",
        description: "Resize large images to 2000x2000 max for better model compatibility",
    },
},
``` 

### Image Processing and Display

When an image is read, the system detects its MIME type . If it's an image, it's read as a binary buffer . Large images are checked against `MAX_IMAGE_SIZE` to prevent errors . Images can be automatically resized if `images.autoResize` is enabled . The `resizeImage` function handles the resizing, and if successful, the image data is returned as base64 along with its dimensions .

For fetched images, if the image exceeds `MAX_INLINE_IMAGE_SOURCE_BYTES`, a warning is issued, and the image is not inlined . Images are also resized for better model compatibility, with a tighter budget for screenshots to avoid `request_too_large` errors .

The `Image` component in the TUI is responsible for rendering images in the terminal . It uses `TERMINAL.imageProtocol` to determine if the terminal supports image rendering protocols like Kitty, iTerm2, or SIXEL . If supported, the image is rendered using `renderImage` . Otherwise, a fallback text is displayed .

## Notes

The provided context does not contain a dedicated wiki page for "Image Support". The information above is synthesized from the `README.md` file  and relevant code snippets that implement image handling and display. The `Tools System` wiki page mentions "Image Detection" as a feature of the `ReadTool` , which is further elaborated in `packages/coding-agent/src/tools/read.ts` . The `packages/coding-agent/src/config/settings-schema.ts` file defines the configuration options related to image display and resizing . The `packages/tui/src/components/image.ts` file is responsible for the actual rendering of images in the terminal .

Wiki pages you might want to explore:
- [Tools System (DefaceRoot/oh-my-pi)](/wiki/DefaceRoot/oh-my-pi#6)

View this search on DeepWiki: https://app.devin.ai/search/give-me-the-complete-detailed_879f64c2-a851-44f1-abd0-71caacbac0f5

