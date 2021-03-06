pc.extend(pc, function () {

    function sortDrawCalls(drawCallA, drawCallB) {
        if (drawCallA.zdist && drawCallB.zdist) {
            return drawCallB.zdist - drawCallA.zdist;
        } else {
            return drawCallB.key - drawCallA.key;
        }
    }

    // Global shadowmap resources
    var scaleShift = new pc.Mat4().mul2(
        new pc.Mat4().setTranslate(0.5, 0.5, 0.5),
        new pc.Mat4().setScale(0.5, 0.5, 0.5)
    );

    var directionalShadowEpsilon = 0.01;
    var pixelOffset = new pc.Vec2();
    var blurScissorRect = {x:1, y:1, z:0, w:0};

    var shadowCamView = new pc.Mat4();
    var shadowCamViewProj = new pc.Mat4();
    var c2sc = new pc.Mat4();

    var viewInvMat = new pc.Mat4();
    var viewMat = new pc.Mat4();
    var viewMat3 = new pc.Mat3();
    var viewProjMat = new pc.Mat4();
    var frustumDiagonal = new pc.Vec3();
    var tempSphere = {};
    var meshPos;
    var visibleSceneAabb = new pc.BoundingBox();

    var shadowMapCache = [{}, {}, {}, {}];
    var shadowMapCubeCache = {};
    var maxBlurSize = 25;

    // The 8 points of the camera frustum transformed to light space
    var frustumPoints = [];
    for (var i = 0; i < 8; i++) {
        frustumPoints.push(new pc.Vec3());
    }

    function _getFrustumPoints(camera, farClip, points) {
        var nearClip   = camera.getNearClip();
        var fov        = camera.getFov() * Math.PI / 180.0;
        var aspect     = camera.getAspectRatio();
        var projection = camera.getProjection();

        var x, y;
        if (projection === pc.PROJECTION_PERSPECTIVE) {
            y = Math.tan(fov / 2.0) * nearClip;
        } else {
            y = camera._orthoHeight;
        }
        x = y * aspect;

        points[0].x = x;
        points[0].y = -y;
        points[0].z = -nearClip;
        points[1].x = x;
        points[1].y = y;
        points[1].z = -nearClip;
        points[2].x = -x;
        points[2].y = y;
        points[2].z = -nearClip;
        points[3].x = -x;
        points[3].y = -y;
        points[3].z = -nearClip;

        if (projection === pc.PROJECTION_PERSPECTIVE) {
            y = Math.tan(fov / 2.0) * farClip;
            x = y * aspect;
        }
        points[4].x = x;
        points[4].y = -y;
        points[4].z = -farClip;
        points[5].x = x;
        points[5].y = y;
        points[5].z = -farClip;
        points[6].x = -x;
        points[6].y = y;
        points[6].z = -farClip;
        points[7].x = -x;
        points[7].y = -y;
        points[7].z = -farClip;

        return points;
    }

    function StaticArray(size) {
        var data = new Array(size);
        var obj = function(idx) { return data[idx]; }
        obj.size = 0;
        obj.push = function(v) {
            data[this.size] = v;
            ++this.size;
        }
        obj.data = data;
        return obj;
    }
    var intersectCache = {
        temp          : [new pc.Vec3(), new pc.Vec3(), new pc.Vec3()],
        vertices      : new Array(3),
        negative      : new StaticArray(3),
        positive      : new StaticArray(3),
        intersections : new StaticArray(3),
        zCollection   : new StaticArray(36)
    };
    function _groupVertices(coord, face, smallerIsNegative) {
        var intersections = intersectCache.intersections;
        var small, large;
        if (smallerIsNegative) {
            small = intersectCache.negative;
            large = intersectCache.positive;
        } else {
            small = intersectCache.positive;
            large = intersectCache.negative;
        }

        intersections.size = 0;
        small.size = 0;
        large.size = 0;

        // Grouping vertices according to the position related the the face
        var intersectCount = 0;
        var v;
        for (var j = 0; j < 3; ++j) {
            v = intersectCache.vertices[j];

            if (v[coord] < face) {
                small.push(v);
            } else if (v[coord] === face) {
                intersections.push(intersectCache.temp[intersections.size].copy(v));
            } else {
                large.push(v);
            }
        }
    }
    function _triXFace(zs, x, y, faceTest, yMin, yMax) {

        var negative = intersectCache.negative;
        var positive = intersectCache.positive;
        var intersections = intersectCache.intersections;

        // Find intersections
        if (negative.size === 3) {
            // Everything is on the negative side of the left face.
            // The triangle won't intersect with the frustum. So ignore it
            return false;
        }

        if (negative.size && positive.size) {
            intersections.push(intersectCache.temp[intersections.size].lerp(
                negative(0), positive(0), (faceTest - negative(0)[x]) / (positive(0)[x] - negative(0)[x])
            ));
            if (negative.size === 2) {
                // 2 on the left, 1 on the right
                intersections.push(intersectCache.temp[intersections.size].lerp(
                    negative(1), positive(0), (faceTest - negative(1)[x]) / (positive(0)[x] - negative(1)[x])
                ));
            } else if (positive.size === 2) {
                // 1 on the left, 2 on the right
                intersections.push(intersectCache.temp[intersections.size].lerp(
                    negative(0), positive(1), (faceTest - negative(0)[x]) / (positive(1)[x] - negative(0)[x])
                ));
            }
        }

        // Get the z of the intersections
        if (intersections.size === 0) {
          return true;
        }
        if (intersections.size === 1) {
            // If there's only one vertex intersect the face
            // Test if it's within the range of top/bottom faces.
            if (yMin <= intersections(0)[y] && intersections(0)[y] <= yMax) {
                zs.push(intersections(0).z);
            }
            return true;
        }
        // There's multiple intersections ( should only be two intersections. )
        if (intersections(1)[y] === intersections(0)[y]) {
            if (yMin <= intersections(0)[y] && intersections(0)[y] <= yMax) {
                zs.push(intersections(0).z);
                zs.push(intersections(1).z);
            }
        } else {
            var delta = (intersections(1).z - intersections(0).z) / (intersections(1)[y] - intersections(0)[y]);
            if (intersections(0)[y] > yMax) {
                zs.push(intersections(0).z + delta * (yMax - intersections(0)[y]));
            } else if (intersections(0)[y] < yMin) {
                zs.push(intersections(0).z + delta * (yMin - intersections(0)[y]));
            } else {
                zs.push(intersections(0).z);
            }
            if (intersections(1)[y] > yMax) {
                zs.push(intersections(1).z + delta * (yMax - intersections(1)[y]));
            } else if (intersections(1)[y] < yMin) {
                zs.push(intersections(1).z + delta * (yMin - intersections(1)[y]));
            } else {
                zs.push(intersections(1).z);
            }
        }
        return true;
    };

    var _sceneAABB_LS = [
        new pc.Vec3(), new pc.Vec3(), new pc.Vec3(), new pc.Vec3(),
        new pc.Vec3(), new pc.Vec3(), new pc.Vec3(), new pc.Vec3()
    ];
    var iAABBTriIndexes = [
        0,1,2,  1,2,3,
        4,5,6,  5,6,7,
        0,2,4,  2,4,6,
        1,3,5,  3,5,7,
        0,1,4,  1,4,5,
        2,3,6,  3,6,7
    ];
    function _getZFromAABB(w2sc, aabbMin, aabbMax, lcamMinX, lcamMaxX, lcamMinY, lcamMaxY) {
        _sceneAABB_LS[0].x = _sceneAABB_LS[1].x = _sceneAABB_LS[2].x = _sceneAABB_LS[3].x = aabbMin.x;
        _sceneAABB_LS[1].y = _sceneAABB_LS[3].y = _sceneAABB_LS[7].y = _sceneAABB_LS[5].y = aabbMin.y;
        _sceneAABB_LS[2].z = _sceneAABB_LS[3].z = _sceneAABB_LS[6].z = _sceneAABB_LS[7].z = aabbMin.z;
        _sceneAABB_LS[4].x = _sceneAABB_LS[5].x = _sceneAABB_LS[6].x = _sceneAABB_LS[7].x = aabbMax.x;
        _sceneAABB_LS[0].y = _sceneAABB_LS[2].y = _sceneAABB_LS[4].y = _sceneAABB_LS[6].y = aabbMax.y;
        _sceneAABB_LS[0].z = _sceneAABB_LS[1].z = _sceneAABB_LS[4].z = _sceneAABB_LS[5].z = aabbMax.z;

        for ( var i = 0; i < 8; ++i ) {
            w2sc.transformPoint( _sceneAABB_LS[i], _sceneAABB_LS[i] );
        }

        var minz = 9999999999;
        var maxz = -9999999999;

        var vertices = intersectCache.vertices;
        var positive = intersectCache.positive;
        var zs       = intersectCache.zCollection;
        zs.size = 0;

        for (var AABBTriIter = 0; AABBTriIter < 12; ++AABBTriIter) {
          vertices[0] = _sceneAABB_LS[iAABBTriIndexes[AABBTriIter * 3 + 0]];
          vertices[1] = _sceneAABB_LS[iAABBTriIndexes[AABBTriIter * 3 + 1]];
          vertices[2] = _sceneAABB_LS[iAABBTriIndexes[AABBTriIter * 3 + 2]];

          var verticesWithinBound = 0;

          _groupVertices("x", lcamMinX, true);
          if (!_triXFace(zs, "x", "y", lcamMinX, lcamMinY, lcamMaxY)) continue;
          verticesWithinBound += positive.size;

          _groupVertices("x", lcamMaxX, false);
          if (!_triXFace(zs, "x", "y", lcamMaxX, lcamMinY, lcamMaxY)) continue;
          verticesWithinBound += positive.size;

          _groupVertices("y", lcamMinY, true);
          if (!_triXFace(zs, "y", "x", lcamMinY, lcamMinX, lcamMaxX)) continue;
          verticesWithinBound += positive.size;

          _groupVertices("y", lcamMaxY, false);
          _triXFace(zs, "y", "x", lcamMaxY, lcamMinX, lcamMaxX);
          if ( verticesWithinBound + positive.size == 12 ) {
            // The triangle does not go outside of the frustum bound.
            zs.push( vertices[0].z );
            zs.push( vertices[1].z );
            zs.push( vertices[2].z );
          }
        }

        var z;
        for (var j = 0, len = zs.size; j < len; j++) {
            z = zs(j);
            if (z < minz) minz = z;
            if (z > maxz) maxz = z;
        }
        return { min: minz, max: maxz };
    }

    function _getZFromAABBSimple(w2sc, aabbMin, aabbMax, lcamMinX, lcamMaxX, lcamMinY, lcamMaxY) {
        _sceneAABB_LS[0].x = _sceneAABB_LS[1].x = _sceneAABB_LS[2].x = _sceneAABB_LS[3].x = aabbMin.x;
        _sceneAABB_LS[1].y = _sceneAABB_LS[3].y = _sceneAABB_LS[7].y = _sceneAABB_LS[5].y = aabbMin.y;
        _sceneAABB_LS[2].z = _sceneAABB_LS[3].z = _sceneAABB_LS[6].z = _sceneAABB_LS[7].z = aabbMin.z;
        _sceneAABB_LS[4].x = _sceneAABB_LS[5].x = _sceneAABB_LS[6].x = _sceneAABB_LS[7].x = aabbMax.x;
        _sceneAABB_LS[0].y = _sceneAABB_LS[2].y = _sceneAABB_LS[4].y = _sceneAABB_LS[6].y = aabbMax.y;
        _sceneAABB_LS[0].z = _sceneAABB_LS[1].z = _sceneAABB_LS[4].z = _sceneAABB_LS[5].z = aabbMax.z;

        var minz = 9999999999;
        var maxz = -9999999999;
        var z;

        for ( var i = 0; i < 8; ++i ) {
            w2sc.transformPoint( _sceneAABB_LS[i], _sceneAABB_LS[i] );
            z = _sceneAABB_LS[i].z;
            if (z < minz) minz = z;
            if (z > maxz) maxz = z;
        }

        return { min: minz, max: maxz };
    }

    //////////////////////////////////////
    // Shadow mapping support functions //
    //////////////////////////////////////
    function getShadowFormat(shadowType) {
        if (shadowType===pc.SHADOW_VSM32) {
            return pc.PIXELFORMAT_RGBA32F;
        } else if (shadowType===pc.SHADOW_VSM16) {
            return pc.PIXELFORMAT_RGBA16F;
        }
        return pc.PIXELFORMAT_R8_G8_B8_A8;
    }

    function getShadowFiltering(device, shadowType) {
        if (shadowType===pc.SHADOW_DEPTH) {
            return pc.FILTER_NEAREST;
        } else if (shadowType===pc.SHADOW_VSM32) {
            return device.extTextureFloatLinear? pc.FILTER_LINEAR : pc.FILTER_NEAREST;
        } else if (shadowType===pc.SHADOW_VSM16) {
            return device.extTextureHalfFloatLinear? pc.FILTER_LINEAR : pc.FILTER_NEAREST;
        }
        return pc.FILTER_LINEAR;
    }

    function createShadowMap(device, width, height, shadowType) {
        var format = getShadowFormat(shadowType);
        var shadowMap = new pc.Texture(device, {
            format: format,
            width: width,
            height: height,
            autoMipmap: false
        });
        var filter = getShadowFiltering(device, shadowType);
        shadowMap.minFilter = filter;
        shadowMap.magFilter = filter;
        shadowMap.addressU = pc.ADDRESS_CLAMP_TO_EDGE;
        shadowMap.addressV = pc.ADDRESS_CLAMP_TO_EDGE;
        return new pc.RenderTarget(device, shadowMap, true);
    }

    function createShadowCubeMap(device, size) {
        var cubemap = new pc.Texture(device, {
            format: pc.PIXELFORMAT_R8_G8_B8_A8,
            width: size,
            height: size,
            cubemap: true,
            autoMipmap: false
        });
        cubemap.minFilter = pc.FILTER_NEAREST;
        cubemap.magFilter = pc.FILTER_NEAREST;
        cubemap.addressU = pc.ADDRESS_CLAMP_TO_EDGE;
        cubemap.addressV = pc.ADDRESS_CLAMP_TO_EDGE;
        var targets = [];
        for (var i = 0; i < 6; i++) {
            var target = new pc.RenderTarget(device, cubemap, {
                face: i,
                depth: true
            });
            targets.push(target);
        }
        return targets;
    }

    function gauss(x, sigma) {
        return Math.exp(-(x * x) / (2.0 * sigma * sigma));
    }

    function gaussWeights(kernelSize) {
        if (kernelSize > maxBlurSize) kernelSize = maxBlurSize;
        var sigma = (kernelSize - 1) / (2*3);
        var i, values, sum, halfWidth;

        halfWidth = (kernelSize - 1) * 0.5;
        values = new Array(kernelSize);
        sum = 0.0;
        for (i = 0; i < kernelSize; ++i) {
            values[i] = gauss(i - halfWidth, sigma);
            sum += values[i];
        }

        for (i = 0; i < kernelSize; ++i) {
            values[i] /= sum;
        }
        return values;
    }

    function createShadowCamera(device, shadowType) {
        // We don't need to clear the color buffer if we're rendering a depth map
        var flags = pc.CLEARFLAG_DEPTH;
        if (!device.extDepthTexture) flags |= pc.CLEARFLAG_COLOR;

        var shadowCam = new pc.Camera();
        shadowCam.setClearOptions({
            color: (shadowType > pc.SHADOW_DEPTH?[0,0,0,0] : [1.0, 1.0, 1.0, 1.0]),
            depth: 1.0,
            flags: flags
        });
        shadowCam._node = new pc.GraphNode();
        return shadowCam;
    }

    function getShadowMapFromCache(device, res, mode, layer) {
        if (!layer) layer = 0;
        var id = layer * 10000 + res;
        var shadowBuffer = shadowMapCache[mode][id];
        if (!shadowBuffer) {
            shadowBuffer = createShadowMap(device, res, res, mode? mode : pc.SHADOW_DEPTH);
            shadowMapCache[mode][id] = shadowBuffer;
        }
        return shadowBuffer;
    }

    function createShadowBuffer(device, light) {
        var shadowBuffer;
        if (light.getType() === pc.LIGHTTYPE_POINT) {
            if (light._shadowType > pc.SHADOW_DEPTH) light._shadowType = pc.SHADOW_DEPTH; // no VSM point lights yet
            if (light._cacheShadowMap) {
                shadowBuffer = shadowMapCubeCache[light._shadowResolution];
                if (!shadowBuffer) {
                    shadowBuffer = createShadowCubeMap(device, light._shadowResolution);
                    shadowMapCubeCache[light._shadowResolution] = shadowBuffer;
                }
            } else {
                shadowBuffer = createShadowCubeMap(device, light._shadowResolution);
            }
            light._shadowCamera.setRenderTarget(shadowBuffer[0]);
            light._shadowCubeMap = shadowBuffer;

        } else {

            if (light._cacheShadowMap) {
                shadowBuffer = getShadowMapFromCache(device, light._shadowResolution, light._shadowType);
            } else {
                shadowBuffer = createShadowMap(device, light._shadowResolution, light._shadowResolution, light._shadowType);
            }

            light._shadowCamera.setRenderTarget(shadowBuffer);
        }
    }

    /**
     * @private
     * @name pc.ForwardRenderer
     * @class The forward renderer render scene objects.
     * @description Creates a new forward renderer object.
     * @param {pc.GraphicsDevice} graphicsDevice The graphics device used by the renderer.
     */
    function ForwardRenderer(graphicsDevice) {
        this.device = graphicsDevice;
        var device = this.device;

        this._depthDrawCalls = 0;
        this._shadowDrawCalls = 0;
        this._forwardDrawCalls = 0;
        this._skinDrawCalls = 0;
        this._instancedDrawCalls = 0;
        this._immediateRendered = 0;
        this._removedByInstancing = 0;
        this._camerasRendered = 0;
        this._materialSwitches = 0;
        this._shadowMapUpdates = 0;
        this._shadowMapTime = 0;
        this._forwardTime = 0;
        this._cullTime = 0;

        // Shaders
        var library = device.getProgramLibrary();
        this.library = library;

        this._depthProgStatic = [];
        this._depthProgSkin = [];
        this._depthProgStaticOp = [];
        this._depthProgSkinOp = [];

        this._depthProgStaticPoint = [];
        this._depthProgSkinPoint = [];
        this._depthProgStaticOpPoint = [];
        this._depthProgSkinOpPoint = [];

        for(var shadowType=0; shadowType<pc.SHADOW_VSM32+1; shadowType++) {
            this._depthProgStaticOp[shadowType] = {};
            this._depthProgSkinOp[shadowType] = {};
            this._depthProgStaticOpPoint[shadowType] = {};
            this._depthProgSkinOpPoint[shadowType] = {};
        }

        // Screen depth (no opacity)
        this._depthShaderStatic = library.getProgram('depth', {
            skin: false
        });
        this._depthShaderSkin = library.getProgram('depth', {
            skin: true
        });
        this._depthShaderStaticOp = {};
        this._depthShaderSkinOp = {};

        var chan = ['r', 'g', 'b', 'a'];
        for(var c=0; c<4; c++) {
            // Screen depth (opacity)
            this._depthShaderStaticOp[chan[c]] = library.getProgram('depth', {
                skin: false,
                opacityMap: true,
                opacityChannel: chan[c]
            });
            this._depthShaderSkinOp[chan[c]] = library.getProgram('depth', {
                skin: true,
                opacityMap: true,
                opacityChannel: chan[c]
            });

            this._depthShaderStaticOp[chan[c]] = library.getProgram('depth', {
                skin: false,
                opacityMap: true,
                opacityChannel: chan[c]
            });
            this._depthShaderSkinOp[chan[c]] = library.getProgram('depth', {
                skin: true,
                opacityMap: true,
                opacityChannel: chan[c]
            });
        }


        // Uniforms
        var scope = device.scope;
        this.projId = scope.resolve('matrix_projection');
        this.viewId = scope.resolve('matrix_view');
        this.viewId3 = scope.resolve('matrix_view3');
        this.viewInvId = scope.resolve('matrix_viewInverse');
        this.viewProjId = scope.resolve('matrix_viewProjection');
        this.viewPosId = scope.resolve('view_position');
        this.nearClipId = scope.resolve('camera_near');
        this.farClipId = scope.resolve('camera_far');
        this.shadowMapLightRadiusId = scope.resolve('light_radius');

        this.fogColorId = scope.resolve('fog_color');
        this.fogStartId = scope.resolve('fog_start');
        this.fogEndId = scope.resolve('fog_end');
        this.fogDensityId = scope.resolve('fog_density');

        this.modelMatrixId = scope.resolve('matrix_model');
        this.normalMatrixId = scope.resolve('matrix_normal');
        this.poseMatrixId = scope.resolve('matrix_pose[0]');
        this.boneTextureId = scope.resolve('texture_poseMap');
        this.boneTextureSizeId = scope.resolve('texture_poseMapSize');
        this.skinPosOffsetId = scope.resolve('skinPosOffset');

        this.alphaTestId = scope.resolve('alpha_ref');
        this.opacityMapId = scope.resolve('texture_opacityMap');

        this.ambientId = scope.resolve("light_globalAmbient");
        this.exposureId = scope.resolve("exposure");
        this.skyboxIntensityId = scope.resolve("skyboxIntensity");
        this.lightColorId = [];
        this.lightDirId = [];
        this.lightShadowMapId = [];
        this.lightShadowMatrixId = [];
        this.lightShadowParamsId = [];
        this.lightShadowMatrixVsId = [];
        this.lightShadowParamsVsId = [];
        this.lightDirVsId = [];
        this.lightRadiusId = [];
        this.lightPosId = [];
        this.lightInAngleId = [];
        this.lightOutAngleId = [];
        this.lightPosVsId = [];

        this.depthMapId = scope.resolve('uDepthMap');
        this.screenSizeId = scope.resolve('uScreenSize');
        this._screenSize = new pc.Vec4();

        this.sourceId = scope.resolve("source");
        this.pixelOffsetId = scope.resolve("pixelOffset");
        this.weightId = scope.resolve("weight[0]");
        var chunks = pc.shaderChunks;
        this.blurVsmShaderCode = [chunks.blurVSMPS, "#define GAUSS\n" + chunks.blurVSMPS];
        var packed = "#define PACKED\n";
        this.blurPackedVsmShaderCode = [packed + this.blurVsmShaderCode[0], packed + this.blurVsmShaderCode[1]];
        this.blurVsmShader = [{}, {}];
        this.blurPackedVsmShader = [{}, {}];
        this.blurVsmWeights = {};

        this.fogColor = new Float32Array(3);
        this.ambientColor = new Float32Array(3);
    }

    pc.extend(ForwardRenderer.prototype, {

        _isVisible: function(camera, meshInstance) {
            meshPos = meshInstance.aabb.center;
            if (meshInstance.node._dirtyScale) {
                meshInstance._aabb._radius = meshInstance._aabb.halfExtents.length();
                meshInstance.node._dirtyScale = false;
            }

            tempSphere.radius = meshInstance._aabb._radius;
            tempSphere.center = meshPos;

            return camera._frustum.containsSphere(tempSphere);
        },

        getShadowCamera: function(device, light) {
            var shadowCam = light._shadowCamera;
            var shadowBuffer;

            if (shadowCam === null) {
                shadowCam = light._shadowCamera = createShadowCamera(device, light._shadowType);
                createShadowBuffer(device, light);
            } else {
                shadowBuffer = shadowCam.getRenderTarget();
                if ((shadowBuffer.width !== light._shadowResolution) || (shadowBuffer.height !== light._shadowResolution)) {
                    createShadowBuffer(device, light);
                }
            }

            return shadowCam;
        },

        updateCameraFrustum: function(camera) {
            var projMat = camera.getProjectionMatrix();

            var pos = camera._node.getPosition();
            var rot = camera._node.getRotation();
            viewInvMat.setTRS(pos, rot, pc.Vec3.ONE);
            this.viewInvId.setValue(viewInvMat.data);

            viewMat.copy(viewInvMat).invert();

            camera._frustum.update(projMat, viewMat);
        },

        setCamera: function (camera, cullBorder) {
            // Projection Matrix
            var projMat = camera.getProjectionMatrix();
            this.projId.setValue(projMat.data);

            // ViewInverse Matrix
            var pos = camera._node.getPosition();
            var rot = camera._node.getRotation();
            viewInvMat.setTRS(pos, rot, pc.Vec3.ONE);
            this.viewInvId.setValue(viewInvMat.data);

            // View Matrix
            viewMat.copy(viewInvMat).invert();
            this.viewId.setValue(viewMat.data);

            viewMat3.data[0] = viewMat.data[0];
            viewMat3.data[1] = viewMat.data[1];
            viewMat3.data[2] = viewMat.data[2];

            viewMat3.data[3] = viewMat.data[4];
            viewMat3.data[4] = viewMat.data[5];
            viewMat3.data[5] = viewMat.data[6];

            viewMat3.data[6] = viewMat.data[8];
            viewMat3.data[7] = viewMat.data[9];
            viewMat3.data[8] = viewMat.data[10];

            this.viewId3.setValue(viewMat3.data);

            // ViewProjection Matrix
            viewProjMat.mul2(projMat, viewMat);
            this.viewProjId.setValue(viewProjMat.data);

            // View Position (world space)
            this.viewPosId.setValue(camera._node.getPosition().data);

            // Near and far clip values
            this.nearClipId.setValue(camera.getNearClip());
            this.farClipId.setValue(camera.getFarClip());

            camera._frustum.update(projMat, viewMat);

            var device = this.device;
            var target = camera.getRenderTarget();
            device.setRenderTarget(target);
            device.updateBegin();

            var rect = camera.getRect();
            var pixelWidth = target ? target.width : device.width;
            var pixelHeight = target ? target.height : device.height;
            var x = Math.floor(rect.x * pixelWidth);
            var y = Math.floor(rect.y * pixelHeight);
            var w = Math.floor(rect.width * pixelWidth);
            var h = Math.floor(rect.height * pixelHeight);
            device.setViewport(x, y, w, h);
            device.setScissor(x, y, w, h);

            device.clear(camera.getClearOptions());

            if (cullBorder) device.setScissor(1, 1, pixelWidth-2, pixelHeight-2);
        },

        dispatchGlobalLights: function (scene) {
            var i;
            this.mainLight = -1;

            var scope = this.device.scope;

            this.ambientColor[0] = scene.ambientLight.r;
            this.ambientColor[1] = scene.ambientLight.g;
            this.ambientColor[2] = scene.ambientLight.b;
            if (scene.gammaCorrection) {
                for(i=0; i<3; i++) {
                    this.ambientColor[i] = Math.pow(this.ambientColor[i], 2.2);
                }
            }
            this.ambientId.setValue(this.ambientColor);
            this.exposureId.setValue(scene.exposure);
            if (scene._skyboxModel) this.skyboxIntensityId.setValue(scene.skyboxIntensity);
        },

        _resolveLight: function (scope, i) {
            var light = "light" + i;
            this.lightColorId[i] = scope.resolve(light + "_color");
            this.lightDirId[i] = scope.resolve(light + "_direction");
            this.lightShadowMapId[i] = scope.resolve(light + "_shadowMap");
            this.lightShadowMatrixId[i] = scope.resolve(light + "_shadowMatrix");
            this.lightShadowParamsId[i] = scope.resolve(light + "_shadowParams");
            this.lightShadowMatrixVsId[i] = scope.resolve(light + "_shadowMatrixVS");
            this.lightShadowParamsVsId[i] = scope.resolve(light + "_shadowParamsVS");
            this.lightDirVsId[i] = scope.resolve(light + "_directionVS");
            this.lightRadiusId[i] = scope.resolve(light + "_radius");
            this.lightPosId[i] = scope.resolve(light + "_position");
            this.lightInAngleId[i] = scope.resolve(light + "_innerConeAngle");
            this.lightOutAngleId[i] = scope.resolve(light + "_outerConeAngle");
            this.lightPosVsId[i] = scope.resolve(light + "_positionVS");
        },

        dispatchDirectLights: function (scene, mask) {
            var dirs = scene._globalLights;
            var numDirs = dirs.length;
            var i;
            var directional, wtm;
            var cnt = 0;

            var scope = this.device.scope;

            for (i = 0; i < numDirs; i++) {
                if (!(dirs[i].mask & mask)) continue;

                directional = dirs[i];
                wtm = directional._node.getWorldTransform();

                if (!this.lightColorId[cnt]) {
                    this._resolveLight(scope, cnt);
                }

                this.lightColorId[cnt].setValue(scene.gammaCorrection? directional._linearFinalColor.data : directional._finalColor.data);

                // Directionals shine down the negative Y axis
                wtm.getY(directional._direction).scale(-1);
                this.lightDirId[cnt].setValue(directional._direction.normalize().data);

                if (directional.getCastShadows()) {
                    var shadowMap = this.device.extDepthTexture ?
                            directional._shadowCamera._renderTarget._depthTexture :
                            directional._shadowCamera._renderTarget.colorBuffer;

                    // make bias dependent on far plane because it's not constant for direct light
                    var bias = directional._shadowType > pc.SHADOW_DEPTH? -0.00001*20 : (directional._shadowBias / directional._shadowCamera.getFarClip()) * 100;
                    var normalBias = directional._shadowType > pc.SHADOW_DEPTH?
                        directional._vsmBias / (directional._shadowCamera.getFarClip() / 7.0)
                         : directional._normalOffsetBias;

                    this.lightShadowMapId[cnt].setValue(shadowMap);
                    this.lightShadowMatrixId[cnt].setValue(directional._shadowMatrix.data);
                    var params = directional._rendererParams;
                    if (params.length!==3) params.length = 3;
                    params[0] = directional._shadowResolution;
                    params[1] = normalBias;
                    params[2] = bias;
                    this.lightShadowParamsId[cnt].setValue(params);
                    if (this.mainLight < 0) {
                        this.lightShadowMatrixVsId[cnt].setValue(directional._shadowMatrix.data);
                        this.lightShadowParamsVsId[cnt].setValue(params);
                        this.lightDirVsId[cnt].setValue(directional._direction.normalize().data);
                        this.mainLight = i;
                    }
                }
                cnt++;
            }
            return cnt;
        },

        dispatchLocalLights: function (scene, mask, usedDirLights) {
            var i, wtm;
            var point, spot;
            var localLights = scene._localLights;

            var pnts = localLights[pc.LIGHTTYPE_POINT-1];
            var spts = localLights[pc.LIGHTTYPE_SPOT-1];

            var numDirs = usedDirLights;
            var numPnts = pnts.length;
            var numSpts = spts.length;
            var cnt = numDirs;

            var scope = this.device.scope;
            var shadowMap;

            for (i = 0; i < numPnts; i++) {
                if (!(pnts[i].mask & mask)) continue;

                point = pnts[i];
                wtm = point._node.getWorldTransform();

                if (!this.lightColorId[cnt]) {
                    this._resolveLight(scope, cnt);
                }

                this.lightRadiusId[cnt].setValue(point._attenuationEnd);
                this.lightColorId[cnt].setValue(scene.gammaCorrection? point._linearFinalColor.data : point._finalColor.data);
                wtm.getTranslation(point._position);
                this.lightPosId[cnt].setValue(point._position.data);

                if (point.getCastShadows()) {
                    shadowMap = this.device.extDepthTexture ?
                                point._shadowCamera._renderTarget._depthTexture :
                                point._shadowCamera._renderTarget.colorBuffer;
                    this.lightShadowMapId[cnt].setValue(shadowMap);
                    this.lightShadowMatrixId[cnt].setValue(point._shadowMatrix.data);
                    var params = point._rendererParams;
                    if (params.length!==4) params.length = 4;
                    params[0] = point._shadowResolution;
                    params[1] = point._normalOffsetBias;
                    params[2] = point._shadowBias;
                    params[3] = 1.0 / point.getAttenuationEnd();
                    this.lightShadowParamsId[cnt].setValue(params);
                }
                cnt++;
            }

            for (i = 0; i < numSpts; i++) {
                if (!(spts[i].mask & mask)) continue;

                spot = spts[i];
                wtm = spot._node.getWorldTransform();

                if (!this.lightColorId[cnt]) {
                    this._resolveLight(scope, cnt);
                }

                this.lightInAngleId[cnt].setValue(spot._innerConeAngleCos);
                this.lightOutAngleId[cnt].setValue(spot._outerConeAngleCos);
                this.lightRadiusId[cnt].setValue(spot._attenuationEnd);
                this.lightColorId[cnt].setValue(scene.gammaCorrection? spot._linearFinalColor.data : spot._finalColor.data);
                wtm.getTranslation(spot._position);
                this.lightPosId[cnt].setValue(spot._position.data);
                // Spots shine down the negative Y axis
                wtm.getY(spot._direction).scale(-1);
                this.lightDirId[cnt].setValue(spot._direction.normalize().data);

                if (spot.getCastShadows()) {
                    var bias = spot._shadowType > pc.SHADOW_DEPTH? -0.00001*20 : spot._shadowBias * 20; // approx remap from old bias values
                    var normalBias = spot._shadowType > pc.SHADOW_DEPTH?
                        spot._vsmBias / (spot.getAttenuationEnd() / 7.0)
                        : spot._normalOffsetBias;

                    shadowMap = this.device.extDepthTexture ?
                                spot._shadowCamera._renderTarget._depthTexture :
                                spot._shadowCamera._renderTarget.colorBuffer;
                    this.lightShadowMapId[cnt].setValue(shadowMap);
                    this.lightShadowMatrixId[cnt].setValue(spot._shadowMatrix.data);
                    var params = spot._rendererParams;
                    if (params.length!==4) params.length = 4;
                    params[0] = spot._shadowResolution;
                    params[1] = normalBias;
                    params[2] = bias;
                    params[3] = 1.0 / spot.getAttenuationEnd();
                    this.lightShadowParamsId[cnt].setValue(params);
                    if (this.mainLight < 0) {
                        this.lightShadowMatrixVsId[cnt].setValue(spot._shadowMatrix.data);
                        this.lightShadowParamsVsId[cnt].setValue(params);
                        this.lightPosVsId[cnt].setValue(spot._position.data);
                        this.mainLight = i;
                    }
                }
                cnt++;
            }
        },

        /**
         * @private
         * @function
         * @name pc.ForwardRenderer#render
         * @description Renders the scene using the specified camera.
         * @param {pc.Scene} scene The scene to render.
         * @param {pc.Camera} camera The camera with which to render the scene.
         */
        render: function (scene, camera) {
            var device = this.device;
            var scope = device.scope;

            scene._activeCamera = camera;

            if (scene.updateShaders) {
                scene.updateShadersFunc(device);
                scene.updateShaders = false;
            }

            var target = camera.getRenderTarget();
            var isHdr = false;
            var oldGamma = scene._gammaCorrection;
            var oldTonemap = scene._toneMapping;
            var oldExposure = scene.exposure;
            if (target) {
                var format = target.colorBuffer.format;
                if (format===pc.PIXELFORMAT_RGB16F || format===pc.PIXELFORMAT_RGB32F) {
                    isHdr = true;
                    scene._gammaCorrection = pc.GAMMA_NONE;
                    scene._toneMapping = pc.TONEMAP_LINEAR;
                    scene.exposure = 1;
                }
            }

            var i, j, numInstances, light;
            var lights = scene._lights;
            var models = scene._models;

            var drawCalls = scene.drawCalls;
            var drawCallsCount = drawCalls.length;
            var shadowCasters = scene.shadowCasters;

            var drawCall, meshInstance, prevMeshInstance = null, mesh, material, prevMaterial = null, style;
            var boneTexture;

            // Sort lights by type
            scene._globalLights.length = 0;
            scene._localLights[0].length = 0;
            scene._localLights[1].length = 0;

            for (i = 0; i < lights.length; i++) {
                light = lights[i];
                if (light.getEnabled()) {
                    if (light.getType() === pc.LIGHTTYPE_DIRECTIONAL) {
                        scene._globalLights.push(light);
                    } else {
                        scene._localLights[light.getType() === pc.LIGHTTYPE_POINT ? 0 : 1].push(light);
                    }
                }
            }

            var culled = [];
            var visible;
            var btype;
            var emptyAabb;
            var drawCallAabb;
            var cullTime;
            this.updateCameraFrustum(camera);

            // Update all skin matrices to properly cull skinned objects (but don't update rendering data)
            for (i = 0; i < drawCallsCount; i++) {
                drawCall = drawCalls[i];
                if (drawCall.skinInstance) {
                    drawCall.skinInstance.updateMatrices();
                }
            }

            // Calculate the distance of transparent meshes from the camera
            // and cull too
            var camPos = camera._node.getPosition();
            var camFwd = camera._node.forward;
            for (i = 0; i < drawCallsCount; i++) {
                drawCall = drawCalls[i];
                visible = true;
                meshPos = null;
                if (!drawCall.command) {
                    if (drawCall._hidden) continue; // use _hidden property to quickly hide/show meshInstances
                    meshInstance = drawCall;

                    // Only alpha sort and cull mesh instances in the main world
                    if (meshInstance.layer === pc.LAYER_WORLD) {

                        // #ifdef PROFILER
                        cullTime = pc.now();
                        // #endif
                        if (camera.frustumCulling && drawCall.cull) {
                            visible = this._isVisible(camera, meshInstance);
                        }
                        // #ifdef PROFILER
                        this._cullTime += pc.now() - cullTime;
                        // #endif
                        if (visible) {
                            btype = meshInstance.material.blendType;
                            if (btype !== pc.BLEND_NONE) {
                                // alpha sort
                                if (!meshPos) meshPos = meshInstance.aabb.center;
                                var tempx = meshPos.x - camPos.x;
                                var tempy = meshPos.y - camPos.y;
                                var tempz = meshPos.z - camPos.z;
                                meshInstance.zdist = tempx*camFwd.x + tempy*camFwd.y + tempz*camFwd.z;
                            } else if (meshInstance.zdist !== undefined) {
                                delete meshInstance.zdist;
                            }
                        }
                    }
                }
                if (visible) culled.push(drawCall);
            }

            for(i=0; i<scene.immediateDrawCalls.length; i++) {
                culled.push(scene.immediateDrawCalls[i]);
            }
            this._immediateRendered += scene.immediateDrawCalls.length;
            drawCalls = culled;
            drawCallsCount = culled.length;

            // Update all skin matrix palettes
            for (i = 0; i < drawCallsCount; i++) {
                drawCall = drawCalls[i];
                if (drawCall.skinInstance) {
                    drawCall.skinInstance.updateMatrixPalette();
                }
            }

            // Sort meshes into the correct render order
            drawCalls.sort(sortDrawCalls);

            // Render a depth target if the camera has one assigned
            var opChan = 'r';
            var shadowType;
            var library = this.library;
            if (camera._renderDepthRequests) {
                var rect = camera._rect;
                var width = Math.floor(rect.width * device.width);
                var height = Math.floor(rect.height * device.height);

                if (camera._depthTarget && (camera._depthTarget.width!==width || camera._depthTarget.height!==height)) {
                    camera._depthTarget.destroy();
                    camera._depthTarget = null;
                }

                if (!camera._depthTarget) {
                    var colorBuffer = new pc.Texture(device, {
                        format: pc.PIXELFORMAT_R8_G8_B8_A8,
                        width: width,
                        height: height
                    });
                    colorBuffer.minFilter = pc.FILTER_NEAREST;
                    colorBuffer.magFilter = pc.FILTER_NEAREST;
                    colorBuffer.addressU = pc.ADDRESS_CLAMP_TO_EDGE;
                    colorBuffer.addressV = pc.ADDRESS_CLAMP_TO_EDGE;
                    camera._depthTarget = new pc.RenderTarget(device, colorBuffer, {
                        depth: true
                    });
                }

                var oldTarget = camera.getRenderTarget();
                camera.setRenderTarget(camera._depthTarget);
                this.setCamera(camera);

                var oldBlending = device.getBlending();
                device.setBlending(false);

                for (i = 0; i < drawCallsCount; i++) {
                    meshInstance = drawCalls[i];
                    if (!meshInstance.command && meshInstance.drawToDepth && meshInstance.material.blendType===pc.BLEND_NONE) {
                        mesh = meshInstance.mesh;

                        this.modelMatrixId.setValue(meshInstance.node.worldTransform.data);

                        material = meshInstance.material;
                        if (material.opacityMap) {
                            this.opacityMapId.setValue(material.opacityMap);
                            this.alphaTestId.setValue(material.alphaTest);
                            if (material.opacityMapChannel) opChan = material.opacityMapChannel;
                        }

                        if (meshInstance.skinInstance) {
                            this._skinDrawCalls++;
                            this.skinPosOffsetId.setValue(meshInstance.skinInstance.rootNode.getPosition().data);
                            if (device.supportsBoneTextures) {
                                boneTexture = meshInstance.skinInstance.boneTexture;
                                this.boneTextureId.setValue(boneTexture);
                                this.boneTextureSizeId.setValue([boneTexture.width, boneTexture.height]);
                            } else {
                                this.poseMatrixId.setValue(meshInstance.skinInstance.matrixPalette);
                            }
                            device.setShader(material.opacityMap ? this._depthShaderSkinOp[opChan] : this._depthShaderSkin);
                        } else {
                            device.setShader(material.opacityMap ? this._depthShaderStaticOp[opChan] : this._depthShaderStatic);
                        }

                        style = meshInstance.renderStyle;

                        device.setVertexBuffer(mesh.vertexBuffer, 0);
                        device.setIndexBuffer(mesh.indexBuffer[style]);
                        device.draw(mesh.primitive[style]);
                        this._depthDrawCalls++;
                    }

                    camera.setRenderTarget(oldTarget);
                }
                device.setBlending(oldBlending);
            } else {
                if (camera._depthTarget) {
                    camera._depthTarget.destroy();
                    camera._depthTarget = null;
                }
            }

            // Render all shadowmaps
            var minx, miny, minz, maxx, maxy, maxz, centerx, centery;
            var shadowShader;

            // #ifdef PROFILER
            var shadowMapStartTime = pc.now();
            // #endif

            for (i = 0; i < lights.length; i++) {
                light = lights[i];
                var type = light.getType();

                if (light.getCastShadows() && light.getEnabled() && light.shadowUpdateMode!==pc.SHADOWUPDATE_NONE) {
                    if (light.shadowUpdateMode===pc.SHADOWUPDATE_THISFRAME) light.shadowUpdateMode = pc.SHADOWUPDATE_NONE;
                    var shadowCam = this.getShadowCamera(device, light);

                    var passes = 1;
                    var pass;
                    var frustumSize;

                    shadowCam._node.setPosition(light._node.getPosition());
                    shadowCam._node.setRotation(light._node.getRotation());
                    // Camera's look down negative Z, and directional lights point down negative Y
                    shadowCam._node.rotateLocal(-90, 0, 0);

                    if (type === pc.LIGHTTYPE_DIRECTIONAL) {

                        // Positioning directional light frustum I
                        // Construct light's orthographic frustum around camera frustum
                        // Use very large near/far planes this time

                        // 1. Get the frustum of the camera
                        _getFrustumPoints(camera, light.getShadowDistance()||camera.getFarClip(), frustumPoints);

                        // 2. Figure out the maximum diagonal of the frustum in light's projected space.
                        frustumSize = frustumDiagonal.sub2( frustumPoints[0], frustumPoints[6] ).length();
                        frustumSize = Math.max( frustumSize, frustumDiagonal.sub2( frustumPoints[4], frustumPoints[6] ).length() );

                        // 3. Transform the 8 corners of the camera frustum into the shadow camera's view space
                        shadowCamView.copy( shadowCam._node.getWorldTransform() ).invert();
                        c2sc.copy( shadowCamView ).mul( camera._node.worldTransform );
                        for (j = 0; j < 8; j++) {
                            c2sc.transformPoint(frustumPoints[j], frustumPoints[j]);
                        }

                        // 4. Come up with a bounding box (in light-space) by calculating the min
                        // and max X, Y, and Z values from your 8 light-space frustum coordinates.
                        minx = miny = minz = 1000000;
                        maxx = maxy = maxz = -1000000;
                        for (j = 0; j < 8; j++) {
                            var p = frustumPoints[j];
                            if (p.x < minx) minx = p.x;
                            if (p.x > maxx) maxx = p.x;
                            if (p.y < miny) miny = p.y;
                            if (p.y > maxy) maxy = p.y;
                            if (p.z < minz) minz = p.z;
                            if (p.z > maxz) maxz = p.z;
                        }

                        // 5. Enlarge the light's frustum so that the frustum will be the same size
                        // no matter how the view frustum moves.
                        // And also snap the frustum to align with shadow texel. ( Avoid shadow shimmering )
                        var unitPerTexel = frustumSize / light.getShadowResolution();
                        var delta = (frustumSize - (maxx - minx)) * 0.5;
                        minx = Math.floor( (minx - delta) / unitPerTexel ) * unitPerTexel;
                        delta = (frustumSize - (maxy - miny)) * 0.5;
                        miny = Math.floor( (miny - delta) / unitPerTexel ) * unitPerTexel;
                        maxx = minx + frustumSize;
                        maxy = miny + frustumSize;

                        // 6. Use your min and max values to create an off-center orthographic projection.
                        centerx = (maxx + minx) * 0.5;
                        centery = (maxy + miny) * 0.5;
                        shadowCam._node.translateLocal(centerx, centery, 100000);

                        shadowCam.setProjection( pc.PROJECTION_ORTHOGRAPHIC );
                        shadowCam.setNearClip( 0 );
                        shadowCam.setFarClip(200000);
                        shadowCam.setAspectRatio( 1 ); // The light's frustum is a cuboid.
                        shadowCam.setOrthoHeight( frustumSize * 0.5 );

                    } else if (type === pc.LIGHTTYPE_SPOT) {

                        // don't update invisible light
                        if (camera.frustumCulling) {
                            light._node.getWorldTransform();
                            light.getBoundingSphere(tempSphere);
                            if (!camera._frustum.containsSphere(tempSphere)) continue;
                        }

                        shadowCam.setProjection(pc.PROJECTION_PERSPECTIVE);
                        shadowCam.setNearClip(light.getAttenuationEnd() / 1000);
                        shadowCam.setFarClip(light.getAttenuationEnd());
                        shadowCam.setAspectRatio(1);
                        shadowCam.setFov(light.getOuterConeAngle() * 2);

                        this.viewPosId.setValue(shadowCam._node.getPosition().data);
                        this.shadowMapLightRadiusId.setValue(light.getAttenuationEnd());

                    } else if (type === pc.LIGHTTYPE_POINT) {

                        // don't update invisible light
                        if (camera.frustumCulling) {
                            light._node.getWorldTransform();
                            light.getBoundingSphere(tempSphere);
                            if (!camera._frustum.containsSphere(tempSphere)) continue;
                        }

                        shadowCam.setProjection(pc.PROJECTION_PERSPECTIVE);
                        shadowCam.setNearClip(light.getAttenuationEnd() / 1000);
                        shadowCam.setFarClip(light.getAttenuationEnd());
                        shadowCam.setAspectRatio(1);
                        shadowCam.setFov(90);

                        passes = 6;
                        this.viewPosId.setValue(shadowCam._node.getPosition().data);
                        this.shadowMapLightRadiusId.setValue(light.getAttenuationEnd());
                    }


                    this._shadowMapUpdates += passes;

                    opChan = 'r';
                    for(pass=0; pass<passes; pass++){

                        if (type === pc.LIGHTTYPE_POINT) {
                            if (pass===0) {
                                shadowCam._node.setEulerAngles(0, 90, 180);
                            } else if (pass===1) {
                                shadowCam._node.setEulerAngles(0, -90, 180);
                            } else if (pass===2) {
                                shadowCam._node.setEulerAngles(90, 0, 0);
                            } else if (pass===3) {
                                shadowCam._node.setEulerAngles(-90, 0, 0);
                            } else if (pass===4) {
                                shadowCam._node.setEulerAngles(0, 180, 180);
                            } else if (pass===5) {
                                shadowCam._node.setEulerAngles(0, 0, 180);
                            }
                            shadowCam._node.setPosition(light._node.getPosition());
                            shadowCam.setRenderTarget(light._shadowCubeMap[pass]);
                        }

                        this.setCamera(shadowCam, type !== pc.LIGHTTYPE_POINT);

                        // Cull shadow casters
                        culled = [];
                        // #ifdef PROFILER
                        cullTime = pc.now();
                        // #endif
                        for (j = 0, numInstances = shadowCasters.length; j < numInstances; j++) {
                            meshInstance = shadowCasters[j];
                            visible = true;
                            if (meshInstance.cull) {
                                visible = this._isVisible(shadowCam, meshInstance);
                            }
                            if (visible) culled.push(meshInstance);
                        }
                        // #ifdef PROFILER
                        this._cullTime += pc.now() - cullTime;
                        // #endif

                        if (type === pc.LIGHTTYPE_DIRECTIONAL) {

                            // Positioning directional light frustum II
                            // Fit clipping planes tightly around visible shadow casters

                            // 1. Find AABB of visible shadow casters
                            emptyAabb = true;
                            for(j=0; j<culled.length; j++) {
                                meshInstance = culled[j];
                                drawCallAabb = meshInstance.aabb;
                                if (emptyAabb) {
                                    visibleSceneAabb.copy(drawCallAabb);
                                    emptyAabb = false;
                                } else {
                                    visibleSceneAabb.add(drawCallAabb);
                                }
                            }

                            // 2. Calculate minz/maxz based on this AABB
                            var z = _getZFromAABBSimple( shadowCamView, visibleSceneAabb.getMin(), visibleSceneAabb.getMax(), minx, maxx, miny, maxy );

                            // Always use the scene's aabb's Z value
                            // Otherwise object between the light and the frustum won't cast shadow.
                            maxz = z.max;
                            if (z.min > minz) minz = z.min;

                            // 3. Fix projection
                            shadowCam._node.setPosition(light._node.getPosition());
                            shadowCam._node.translateLocal(centerx, centery, maxz + directionalShadowEpsilon);
                            shadowCam.setFarClip( maxz - minz );

                            this.setCamera(shadowCam, true);
                        }

                        if (type !== pc.LIGHTTYPE_POINT) {

                            shadowCamView.setTRS(shadowCam._node.getPosition(), shadowCam._node.getRotation(), pc.Vec3.ONE).invert();
                            shadowCamViewProj.mul2(shadowCam.getProjectionMatrix(), shadowCamView);
                            light._shadowMatrix.mul2(scaleShift, shadowCamViewProj);
                        }

                        device.setBlending(false);
                        device.setColorWrite(true, true, true, true);
                        device.setDepthWrite(true);
                        device.setDepthTest(true);

                        if (device.extDepthTexture) {
                            device.setColorWrite(false, false, false, false);
                        }

                        shadowType = light._shadowType;
                        for (j = 0, numInstances = culled.length; j < numInstances; j++) {
                            meshInstance = culled[j];
                            mesh = meshInstance.mesh;
                            material = meshInstance.material;

                            device.setCullMode(material.cull);

                            this.modelMatrixId.setValue(meshInstance.node.worldTransform.data);
                            if (material.opacityMap) {
                                this.opacityMapId.setValue(material.opacityMap);
                                this.alphaTestId.setValue(material.alphaTest);
                                if (material.opacityMapChannel) opChan = material.opacityMapChannel;
                            }
                            if (meshInstance.skinInstance) {
                                this._skinDrawCalls++;
                                this.skinPosOffsetId.setValue(meshInstance.skinInstance.rootNode.getPosition().data);
                                if (device.supportsBoneTextures) {
                                    boneTexture = meshInstance.skinInstance.boneTexture;
                                    this.boneTextureId.setValue(boneTexture);
                                    this.boneTextureSizeId.setValue([boneTexture.width, boneTexture.height]);
                                } else {
                                    this.poseMatrixId.setValue(meshInstance.skinInstance.matrixPalette);
                                }
                                if (type !== pc.LIGHTTYPE_DIRECTIONAL) {
                                    if (material.opacityMap) {
                                        // Skinned point opacity
                                        shadowShader = this._depthProgSkinOpPoint[shadowType][opChan];
                                        if (!shadowShader) {
                                            shadowShader = this._depthProgSkinOpPoint[shadowType][opChan] = library.getProgram('depthrgba', {
                                                skin: true,
                                                opacityMap: true,
                                                point: true,
                                                shadowType: shadowType,
                                                opacityChannel: opChan
                                            });
                                        }
                                    } else {
                                        // Skinned point
                                        shadowShader = this._depthProgSkinPoint[shadowType];
                                        if (!shadowShader) {
                                            shadowShader = this._depthProgSkinPoint[shadowType] = library.getProgram('depthrgba', {
                                                skin: true,
                                                point: true,
                                                shadowType: shadowType
                                            });
                                        }
                                    }
                                } else {
                                    if (material.opacityMap) {
                                        // Skinned opacity
                                        shadowShader = this._depthProgSkinOp[shadowType][opChan];
                                        if (!shadowShader) {
                                            shadowShader = this._depthProgSkinOp[shadowType][opChan] = library.getProgram('depthrgba', {
                                                skin: true,
                                                opacityMap: true,
                                                shadowType: shadowType,
                                                opacityChannel: opChan
                                            });
                                        }
                                    } else {
                                        // Skinned
                                        shadowShader = this._depthProgSkin[shadowType];
                                        if (!shadowShader) {
                                            shadowShader = this._depthProgSkin[shadowType] = library.getProgram('depthrgba', {
                                                skin: true,
                                                shadowType: shadowType
                                            });
                                        }
                                    }
                                }
                            } else {
                                if (type !== pc.LIGHTTYPE_DIRECTIONAL) {
                                    if (material.opacityMap) {
                                        // Point opacity
                                        shadowShader = this._depthProgStaticOpPoint[shadowType][opChan];
                                        if (!shadowShader) {
                                            shadowShader = this._depthProgStaticOpPoint[shadowType][opChan] = library.getProgram('depthrgba', {
                                                opacityMap: true,
                                                point: true,
                                                shadowType: shadowType,
                                                opacityChannel: opChan
                                            });
                                        }
                                    } else {
                                        // Point
                                        shadowShader = this._depthProgStaticPoint[shadowType];
                                        if (!shadowShader) {
                                            shadowShader = this._depthProgStaticPoint[shadowType] = library.getProgram('depthrgba', {
                                                point: true,
                                                shadowType: shadowType
                                            });
                                        }
                                    }
                                } else {
                                    if (material.opacityMap) {
                                        // Opacity
                                        shadowShader = this._depthProgStaticOp[shadowType][opChan];
                                        if (!shadowShader) {
                                            shadowShader = this._depthProgStaticOp[shadowType][opChan] = library.getProgram('depthrgba', {
                                                opacityMap: true,
                                                shadowType: shadowType,
                                                opacityChannel: opChan
                                            });
                                        }
                                    } else {
                                        //
                                        shadowShader = this._depthProgStatic[shadowType];
                                        if (!shadowShader) {
                                            shadowShader = this._depthProgStatic[shadowType] = library.getProgram('depthrgba', {
                                                shadowType: shadowType
                                            });
                                        }
                                    }
                                }
                            }
                            device.setShader(shadowShader);

                            style = meshInstance.renderStyle;

                            device.setVertexBuffer(mesh.vertexBuffer, 0);
                            device.setIndexBuffer(mesh.indexBuffer[style]);

                            device.draw(mesh.primitive[style]);
                            this._shadowDrawCalls++;
                        }
                    } // end pass

                    if (light._shadowType > pc.SHADOW_DEPTH) {
                        var filterSize = light._vsmBlurSize;
                        if (filterSize > 1) {
                            var origShadowMap = shadowCam.getRenderTarget();
                            var tempRt = getShadowMapFromCache(device, light._shadowResolution, light._shadowType, 1);

                            var blurMode = light._vsmBlurMode;
                            var blurShader = (light._shadowType===pc.SHADOW_VSM8? this.blurPackedVsmShader : this.blurVsmShader)[blurMode][filterSize];
                            if (!blurShader) {
                                this.blurVsmWeights[filterSize] = gaussWeights(filterSize);
                                var chunks = pc.shaderChunks;
                                (light._shadowType===pc.SHADOW_VSM8? this.blurPackedVsmShader : this.blurVsmShader)[blurMode][filterSize] = blurShader =
                                    chunks.createShaderFromCode(this.device, chunks.fullscreenQuadVS,
                                    "#define SAMPLES " + filterSize + "\n" +
                                    (light._shadowType===pc.SHADOW_VSM8? this.blurPackedVsmShaderCode : this.blurVsmShaderCode)
                                    [blurMode], "blurVsm" + blurMode + "" + filterSize + "" + (light._shadowType===pc.SHADOW_VSM8));
                            }

                            blurScissorRect.z = light._shadowResolution - 2;
                            blurScissorRect.w = blurScissorRect.z;

                            // Blur horizontal
                            this.sourceId.setValue(origShadowMap.colorBuffer);
                            pixelOffset.x = 1.0 / light._shadowResolution;
                            pixelOffset.y = 0.0;
                            this.pixelOffsetId.setValue(pixelOffset.data);
                            if (blurMode===pc.BLUR_GAUSSIAN) this.weightId.setValue(this.blurVsmWeights[filterSize]);
                            pc.drawQuadWithShader(device, tempRt, blurShader, null, blurScissorRect);

                            // Blur vertical
                            this.sourceId.setValue(tempRt.colorBuffer);
                            pixelOffset.y = pixelOffset.x;
                            pixelOffset.x = 0.0;
                            this.pixelOffsetId.setValue(pixelOffset.data);
                            pc.drawQuadWithShader(device, origShadowMap, blurShader, null, blurScissorRect);
                        }
                    }
                }
            }
            // #ifdef PROFILER
            this._shadowMapTime = pc.now() - shadowMapStartTime;
            // #endif

            // Set up the camera
            this.setCamera(camera);

            // Set up ambient/exposure
            this.dispatchGlobalLights(scene);

            // Set up the fog
            if (scene.fog !== pc.FOG_NONE) {
                this.fogColor[0] = scene.fogColor.r;
                this.fogColor[1] = scene.fogColor.g;
                this.fogColor[2] = scene.fogColor.b;
                if (scene.gammaCorrection) {
                    for(i=0; i<3; i++) {
                        this.fogColor[i] = Math.pow(this.fogColor[i], 2.2);
                    }
                }
                this.fogColorId.setValue(this.fogColor);
                if (scene.fog === pc.FOG_LINEAR) {
                    this.fogStartId.setValue(scene.fogStart);
                    this.fogEndId.setValue(scene.fogEnd);
                } else {
                    this.fogDensityId.setValue(scene.fogDensity);
                }
            }

            // Set up instancing if needed
            var k;
            if (!pc._instanceVertexFormat) {
                var formatDesc = [
                    { semantic: pc.SEMANTIC_TEXCOORD2, components: 4, type: pc.ELEMENTTYPE_FLOAT32 },
                    { semantic: pc.SEMANTIC_TEXCOORD3, components: 4, type: pc.ELEMENTTYPE_FLOAT32 },
                    { semantic: pc.SEMANTIC_TEXCOORD4, components: 4, type: pc.ELEMENTTYPE_FLOAT32 },
                    { semantic: pc.SEMANTIC_TEXCOORD5, components: 4, type: pc.ELEMENTTYPE_FLOAT32 },
                ];
                pc._instanceVertexFormat = new pc.VertexFormat(device, formatDesc);
            }
            if (device.enableAutoInstancing) {
                if (!pc._autoInstanceBuffer) {
                    pc._autoInstanceBuffer = new pc.VertexBuffer(device, pc._instanceVertexFormat, device.autoInstancingMaxObjects, pc.BUFFER_DYNAMIC);
                    pc._autoInstanceBufferData = new Float32Array(pc._autoInstanceBuffer.lock());
                }
            }
            var next;
            var autoInstances;
            var objDefs, prevObjDefs, lightMask, prevLightMask, paramName, parameter, parameters;

            this._screenSize.x = device.width;
            this._screenSize.y = device.height;
            this._screenSize.z = 1.0 / device.width;
            this._screenSize.w = 1.0 / device.height;
            this.screenSizeId.setValue(this._screenSize.data);
            if (camera._depthTarget) this.depthMapId.setValue(camera._depthTarget.colorBuffer);

            // Render the scene
            // #ifdef PROFILER
            var forwardStartTime = pc.now();
            // #endif
            for (i = 0; i < drawCallsCount; i++) {
                drawCall = drawCalls[i];
                if (drawCall.command) {
                    // We have a command
                    drawCall.command();
                } else {
                    // We have a mesh instance
                    meshInstance = drawCall;
                    mesh = meshInstance.mesh;
                    material = meshInstance.material;
                    objDefs = meshInstance._shaderDefs;
                    lightMask = meshInstance.mask;

                    if (device.enableAutoInstancing && i!==drawCallsCount-1 && device.extInstancing) {
                        next = i + 1;
                        autoInstances = 0;
                        if (drawCalls[next].mesh===mesh && drawCalls[next].material===material) {
                            for(j=0; j<16; j++) {
                                pc._autoInstanceBufferData[j] = drawCall.node.worldTransform.data[j];
                            }
                            autoInstances = 1;
                            while(next!==drawCallsCount && drawCalls[next].mesh===mesh && drawCalls[next].material===material) {
                                for(j=0; j<16; j++) {
                                    pc._autoInstanceBufferData[autoInstances * 16 + j] = drawCalls[next].node.worldTransform.data[j];
                                }
                                autoInstances++;
                                next++;
                            }
                            meshInstance.instancingData = {};
                            meshInstance.instancingData.count = autoInstances;
                            meshInstance.instancingData._buffer = pc._autoInstanceBuffer;
                            meshInstance.instancingData._buffer.unlock();
                            i = next - 1;
                        }
                    }

                    if (meshInstance.instancingData && device.extInstancing) {
                        objDefs |= pc.SHADERDEF_INSTANCING;
                        if (!meshInstance.instancingData._buffer) {
                            meshInstance.instancingData._buffer = new pc.VertexBuffer(device, pc._instanceVertexFormat,
                                drawCall.instancingData.count, drawCall.instancingData.usage, meshInstance.instancingData.buffer);
                        }
                    } else {
                        objDefs &= ~pc.SHADERDEF_INSTANCING;
                        var modelMatrix = meshInstance.node.worldTransform;
                        var normalMatrix = meshInstance.normalMatrix;

                        modelMatrix.invertTo3x3(normalMatrix);
                        normalMatrix.transpose();

                        this.modelMatrixId.setValue(modelMatrix.data);
                        this.normalMatrixId.setValue(normalMatrix.data);
                    }

                    if (meshInstance.skinInstance) {
                        this._skinDrawCalls++;
                        this.skinPosOffsetId.setValue(meshInstance.skinInstance.rootNode.getPosition().data);
                        if (device.supportsBoneTextures) {
                            boneTexture = meshInstance.skinInstance.boneTexture;
                            this.boneTextureId.setValue(boneTexture);
                            this.boneTextureSizeId.setValue([boneTexture.width, boneTexture.height]);
                        } else {
                            this.poseMatrixId.setValue(meshInstance.skinInstance.matrixPalette);
                        }
                    }

                    if (material && material === prevMaterial && objDefs !== prevObjDefs) {
                        prevMaterial = null; // force change shader if the object uses a different variant of the same material
                    }

                    if (material !== prevMaterial) {
                        this._materialSwitches++;
                        if (!meshInstance._shader || meshInstance._shaderDefs !== objDefs) {
                            meshInstance._shader = material.variants[objDefs];
                            if (!meshInstance._shader) {
                                material.updateShader(device, scene, objDefs);
                                meshInstance._shader = material.variants[objDefs] = material.shader;
                            }
                            meshInstance._shaderDefs = objDefs;
                        }
                        device.setShader(meshInstance._shader);

                        // Uniforms I: material
                        parameters = material.parameters;
                        for (paramName in parameters) {
                            parameter = parameters[paramName];
                            if (!parameter.scopeId) {
                                parameter.scopeId = device.scope.resolve(paramName);
                            }
                            parameter.scopeId.setValue(parameter.data);
                        }

                        if (!prevMaterial || lightMask !== prevLightMask) {
                            var usedDirLights = this.dispatchDirectLights(scene, lightMask);
                            this.dispatchLocalLights(scene, lightMask, usedDirLights);
                        }

                        this.alphaTestId.setValue(material.alphaTest);

                        device.setBlending(material.blend);
                        device.setBlendFunction(material.blendSrc, material.blendDst);
                        device.setBlendEquation(material.blendEquation);
                        device.setColorWrite(material.redWrite, material.greenWrite, material.blueWrite, material.alphaWrite);
                        device.setCullMode(material.cull);
                        device.setDepthWrite(material.depthWrite);
                        device.setDepthTest(material.depthTest);
                    }

                    // Uniforms II: meshInstance overrides
                    parameters = meshInstance.parameters;
                    for (paramName in parameters) {
                        parameter = parameters[paramName];
                        if (!parameter.scopeId) {
                            parameter.scopeId = device.scope.resolve(paramName);
                        }
                        parameter.scopeId.setValue(parameter.data);
                    }

                    device.setVertexBuffer(mesh.vertexBuffer, 0);
                    style = meshInstance.renderStyle;
                    device.setIndexBuffer(mesh.indexBuffer[style]);


                    if (meshInstance.instancingData) {
                        this._instancedDrawCalls++;
                        this._removedByInstancing += drawCall.instancingData.count;
                        device.setVertexBuffer(meshInstance.instancingData._buffer, 1);
                        device.draw(mesh.primitive[style], drawCall.instancingData.count);
                        if (meshInstance.instancingData._buffer===pc._autoInstanceBuffer) {
                            meshInstance.instancingData = null;
                        }
                    } else {
                        device.draw(mesh.primitive[style]);
                    }
                    this._forwardDrawCalls++;

                    // Unset meshInstance overrides back to material values if next draw call will use the same material
                    if (i<drawCallsCount-1 && drawCalls[i+1].material===material) {
                        for (paramName in parameters) {
                            parameter = material.parameters[paramName];
                            if (parameter) parameter.scopeId.setValue(parameter.data);
                        }
                    }

                    prevMaterial = material;
                    prevMeshInstance = meshInstance;
                    prevObjDefs = objDefs;
                    prevLightMask = lightMask;
                }
            }
            // #ifdef PROFILER
            this._forwardTime = pc.now() - forwardStartTime;
            // #endif

            device.setColorWrite(true, true, true, true);

            if (scene.immediateDrawCalls.length > 0) {
                scene.immediateDrawCalls = [];
            }

            if (isHdr) {
                scene._gammaCorrection = oldGamma;
                scene._toneMapping = oldTonemap;
                scene.exposure = oldExposure;
            }

            this._camerasRendered++;
        }
    });

    return {
        ForwardRenderer: ForwardRenderer
    };
}());
