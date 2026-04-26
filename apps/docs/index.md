---
layout: home

hero:
  name: "VisualAutoAnnotator"
  tagline: "On-prem annotation editor for computer-vision datasets — detection, segmentation, classification — with YOLO + SAM 2 auto-annotation and video tracking."
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: Annotation tools
      link: /tools

features:
  - title: Manual annotation
    details: Draw bounding boxes, polygons, and masks on images. Tag whole images for classification. All tools work on a WebGL2 canvas in Chrome.
  - title: SAM 2 smart annotation
    details: Click positive and negative points to get an instant predicted mask. Propagate masks across video frames with SAM 2 video tracking.
  - title: YOLO auto-annotate
    details: Upload custom YOLO weights and run auto-annotation on any image in a task. Results appear as draft annotations ready for review.
  - title: Import & export
    details: Export to YOLO (detect / segment / classify) or COCO JSON. Remap or merge classes before export. Import YOLO zips and COCO JSONs to bootstrap a task.
  - title: Multi-user projects
    details: Create projects, define a class palette (index + name + color), and collaborate with your team. Per-task analytics track annotation progress.
  - title: First-run admin wizard
    details: On first visit a setup wizard creates the bootstrap admin account. After that, public registration is locked to admin-only invite.
---
